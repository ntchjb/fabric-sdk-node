/*
 Copyright 2016, 2018 IBM All Rights Reserved.

 SPDX-License-Identifier: Apache-2.0
*/

'use strict';

const sdk_utils = require('./utils.js');
const client_utils = require('./client-utils.js');
const util = require('util');
const path = require('path');
const Peer = require('./Peer.js');
const ChannelEventHub = require('./ChannelEventHub.js');
const Orderer = require('./Orderer.js');
const BlockDecoder = require('./BlockDecoder.js');
const TransactionID = require('./TransactionID.js');
const grpc = require('grpc');
const Long = require('long');
const logger = sdk_utils.getLogger('Channel.js');
const MSPManager = require('./msp/msp-manager.js');
const Policy = require('./Policy.js');
const Constants = require('./Constants.js');
const CollectionConfig = require('./SideDB.js');

const _ccProto = grpc.load(__dirname + '/protos/peer/chaincode.proto').protos;
const _transProto = grpc.load(__dirname + '/protos/peer/transaction.proto').protos;
const _proposalProto = grpc.load(__dirname + '/protos/peer/proposal.proto').protos;
const _responseProto = grpc.load(__dirname + '/protos/peer/proposal_response.proto').protos;
const _queryProto = grpc.load(__dirname + '/protos/peer/query.proto').protos;
const _peerConfigurationProto = grpc.load(__dirname + '/protos/peer/configuration.proto').protos;
const _commonProto = grpc.load(__dirname + '/protos/common/common.proto').common;
const _configtxProto = grpc.load(__dirname + '/protos/common/configtx.proto').common;
const _policiesProto = grpc.load(__dirname + '/protos/common/policies.proto').common;
const _ledgerProto = grpc.load(__dirname + '/protos/common/ledger.proto').common;
const _commonConfigurationProto = grpc.load(__dirname + '/protos/common/configuration.proto').common;
const _ordererConfigurationProto = grpc.load(__dirname + '/protos/orderer/configuration.proto').orderer;
const _abProto = grpc.load(__dirname + '/protos/orderer/ab.proto').orderer;
const _mspConfigProto = grpc.load(__dirname + '/protos/msp/msp_config.proto').msp;
const _mspPrincipalProto = grpc.load(__dirname + '/protos/msp/msp_principal.proto').common;
const _identityProto = grpc.load(path.join(__dirname, '/protos/msp/identities.proto')).msp;
const _discoveryProto = grpc.load(__dirname + '/protos/discovery/protocol.proto').discovery;
const _gossipProto = grpc.load(__dirname + '/protos/gossip/message.proto').gossip;

const ImplicitMetaPolicy_Rule = {0: 'ANY', 1: 'ALL', 2: 'MAJORITY'};

const PEER_NOT_ASSIGNED_MSG = 'Peer with name "%s" not assigned to this channel';
const ORDERER_NOT_ASSIGNED_MSG = 'Orderer with name "%s" not assigned to this channel';

/**
 * In fabric v1.0, channels are the recommended way to isolate data and maintain privacy.
 * <br><br>
 * A Channel object captures the settings needed to interact with a fabric backend in the
 * context of a channel. These settings including the list of participating organizations,
 * represented by instances of Membership Service Providers (MSP), the list of endorsing peers,
 * and an orderer.
 * <br><br>
 * A client application can use the Channel object to create new channels with the orderer,
 * update an existing channel, send various channel-aware requests to the peers such as
 * invoking chaincodes to process transactions or queries.
 * <br><br>
 * A Channel object is also responsible for verifying endorsement signatures in transaction
 * proposal responses. A channel object must be initialized after it has been configured with
 * the list of peers and orderers. The initialization sends a get configuration block request
 * to the primary orderer to retrieve the configuration settings for this channel.
 *
 * @class
 */
const Channel = class {

	/**
	 * Returns a new instance of the class. This is a client-side-only call. To
	 * create a new channel in the fabric, call [createChannel()]{@link Client#createChannel}.
	 *
	 * @param {string} name - Name to identify the channel. This value is used
	 *        as the identifier of the channel when making channel-aware requests
	 *        with the fabric, such as invoking chaincodes to endorse transactions.
	 *        The naming of channels is enforced by the ordering service and must
	 *        be unique within the fabric backend. Channel name in fabric network
	 *        is subject to a pattern revealed in the configuration setting
	 *        <code>channel-name-regx-checker</code>.
	 * @param {Client} clientContext - The client instance, which provides
	 *        operational context such as the signing identity
	 */
	constructor(name, clientContext) {
		if (!name) {
			throw new Error('Failed to create Channel. Missing requirement "name" parameter.');
		}
		if (typeof name !== 'string') {
			throw new Error('Failed to create Channel. channel name should be a string');
		}
		const channelNameRegxChecker = sdk_utils.getConfigSetting('channel-name-regx-checker');
		if (channelNameRegxChecker) {
			const {pattern, flags} = channelNameRegxChecker;
			const namePattern = new RegExp(pattern ? pattern : '', flags ? flags : '');
			if (!(name.match(namePattern))) {
				throw new Error(util.format('Failed to create Channel. channel name should match Regex %s, but got %j', namePattern, name));
			}
		}
		if (!clientContext) {
			throw new Error('Failed to create Channel. Missing requirement "clientContext" parameter.');
		}

		this._name = name;
		this._channel_peers = new Map();
		this._anchor_peers = [];
		this._orderers = new Map();
		this._kafka_brokers = [];
		this._clientContext = clientContext;
		this._msp_manager = new MSPManager();
		this._chaincodes = new Map();
		this._discovery_results = null;
		this._last_discover_timestamp = null;
		this._discovery_peer = null;
		this._use_discovery = sdk_utils.getConfigSetting('initialize-with-discovery', false);

		// setup the endorsement handler
		this._endorsement_handler = null;
		let handler_path = sdk_utils.getConfigSetting('endorsement-handler');
		if (handler_path) {
			this._endorsement_handler = require(handler_path).create(this);
			this._endorsement_handler.initialize();
		}

		// setup the commit handler
		this._commit_handler = null;
		handler_path = sdk_utils.getConfigSetting('commit-handler');
		if (handler_path) {
			this._commit_handler = require(handler_path).create(this);
			this._commit_handler.initialize();
		}


		logger.debug('Constructed Channel instance: name - %s, network mode: %s', this._name, !this._devMode);
	}

	/**
	 * Close the service connections of all assigned peers and orderers
	 */
	close() {
		logger.debug('close - closing connections');
		this._channel_peers.forEach((channel_peer) => {
			channel_peer.close();
		});
		this._orderers.forEach((orderer) => {
			orderer.close();
		});
	}

	/**
	 * @typedef {Object} InitializeRequest
	 * @property {string | Peer | ChannelPeer} target - Optional. The target peer to be used
	 *           to make the initialization requests for configuration information.
	 *           Default is to use the first ChannelPeer assigned to this channel.
	 * @property {boolean} discover - Optional. Use the discovery service on the
	 *           the target peer to load the configuration and network information.
	 *           Default is true. When set to false the target peer will use
	 *           base Peer query to load only the configuration information.
	 * @property {string} endorsementHandler - Optional. The path to a custom
	 *           endorsement handler implementing {@link EndorsementHandler}.
	 * @property {boolean} asLocalhost - Optional. Convert discovered host addresses
	 *           to be 'localhost'. Will be needed when running a docker composed
	 *           fabric network on the local system.
	 * @property {byte[]} configUpdate - Optional. To initialize this channel with
	 *           a serialized ConfigUpdate protobuf object.
	 */

	/**
	 * Initializes the channel object with the Membership Service Providers (MSPs). The channel's
	 * MSPs are critical in providing applications the ability to validate certificates and verify
	 * signatures in messages received from the fabric backend. For instance, after calling
	 * [sendTransactionProposal()]{@link Channel#sendTransactionProposal}, the application can
	 * verify the signatures in the proposal response's endorsements to ensure they have not been
	 * tampered with.
	 * <br><br>
	 * This method retrieves the configuration from the orderer if no "config" parameter is passed in.
	 * Optionally a configuration may be passed in to initialize this channel without making the call
	 * to the orderer.
	 *
	 * @param {byte[] | InitializeRequest} request - Optional.  a {@link InitializeRequest}
	 *        or an encoded (a.k.a un-decoded) byte array of the protobuf "ConfigUpdate"
	 * @return {Promise} A Promise that will resolve when the action is complete
	 */
	async initialize(request) {
		const method = 'initialize';
		logger.debug('%s - start', method);
		let target_peer = this._discovery_peer;

		this._discovery_results = null;
		this._last_discover_timestamp = null;
		let use_discovery = this._use_discovery;

		if (request) {
			if (request.configUpate) {
				this.loadConfigUpdate(request.configUpate);

				return true;
			} else {
				if (typeof request.discover !== 'undefined') {
					if (typeof request.discover === 'boolean') {
						use_discovery = request.discover;
					} else {
						throw new Error('Request parameter "discover" must be boolean');
					}
				}
				if (request.target) {
					target_peer = request.target;
				}
				if (request.endorsementHandler) {
					this._endorsement_handler = require(request.endorsementHandler).create(this);
					this._endorsement_handler.initialize();
				}
			}
		}

		this._last_refresh_request = Object.assign({}, request);
		let discover_results, discover_request;
		if (use_discovery) {
			target_peer = this._getTargetForDiscovery(target_peer);
			if (!target_peer) {
				throw new Error('No target provided for discovery services');
			}
			const chaincodes = {};
			discover_request = {
				target: target_peer,
				config: true
			};

			discover_results = await this._discover(discover_request);
			// chaincode names are in each peer
			if (discover_results && discover_results.peers_by_org) {
				for (const mspid in discover_results.peers_by_org) {
					const org = discover_results.peers_by_org[mspid];
					for (const peer_index in org.peers) {
						const peer = org.peers[peer_index];
						for (const chaincode_index in peer.chaincodes) {
							const chaincode = peer.chaincodes[chaincode_index];
							chaincodes[chaincode.name] = chaincode.version;
						}
					}
				}
			}

			discover_request = {
				target: target_peer,
				config: true,
				chaincodes: Object.keys(chaincodes),
				endpoint_names: true,
				initialize_msps: true
			};

			discover_results = await this._discover(discover_request);
			if (discover_results) {
				if (discover_results.msps) {
					logger.debug('%s - build msps', method);
					for (const msp_name in discover_results.msps) {
						const msp = discover_results.msps[msp_name];
						const config = {
							rootCerts: msp.rootCerts,
							intermediateCerts: msp.intermediateCerts,
							admins: msp.admins,
							cryptoSuite: this._clientContext._crytoSuite,
							id: msp.id,
							orgs: msp.orgs,
							tls_root_certs: msp.tls_root_certs,
							tls_intermediate_certs: msp.tls_intermediate_certs
						};
						this._msp_manager.addMSP(config);
					}
				}

				logger.debug('%s - build target names', method);
				// add orderers names
				if (discover_results.orderers) {
					for (const msp_id in discover_results.orderers) {
						logger.debug('%s - orderers msp:%s', method, msp_id);
						const endpoints = discover_results.orderers[msp_id].endpoints;
						for (const endpoint of endpoints) {
							logger.debug('%s - orderer mspid:%s endpoint:%s:%s', method, msp_id, endpoint.host, endpoint.port);
							endpoint.name = this._buildOrdererName(
								msp_id,
								endpoint.host,
								endpoint.port,
								discover_results.msps,
								request
							);
						}
					}
				}
				// add peer names
				if (discover_results.peers_by_org) {
					for (const msp_id in discover_results.peers_by_org) {
						logger.debug('%s - peers msp:%s', method, msp_id);
						const peers = discover_results.peers_by_org[msp_id].peers;
						for (const index in peers) {
							const peer = peers[index];
							peer.name = this._buildPeerName(
								peer.endpoint,
								peer.mspid,
								discover_results.msps,
								request
							);
							logger.debug('%s - peer:%j', method, peer);
						}
					}
				}
				//add peer names for setEndorsements
				if (discover_results.endorsement_targets) {
					for (const chaincode_name in discover_results.endorsement_targets) {
						const chaincode = discover_results.endorsement_targets[chaincode_name];
						for (const group_name in chaincode.groups) {
							logger.debug('%s - endorsing peer group %s', method, group_name);
							const peers = chaincode.groups[group_name].peers;
							for (const index in peers) {
								const peer = peers[index];
								peer.name = this._buildPeerName(
									peer.endpoint,
									peer.mspid,
									discover_results.msps,
									request
								);
								logger.debug('%s - peer:%j', method, peer);
							}
						}
					}
				}

				discover_results.timestamp = Date.now();
				this._discovery_results = discover_results;
				this._discovery_peer = target_peer;
				this._last_discover_timestamp = discover_results.timestamp;

				return discover_results;
			} else {

				throw new Error('initialization failed');
			}

		} else {
			target_peer = this._getFirstAvailableTarget(target_peer);
			if (!target_peer) {
				throw new Error('No target provided for initialization');
			}
			const config_envelope = await this.getChannelConfig(target_peer);
			logger.debug('initialize - got config envelope from getChannelConfig :: %j', config_envelope);
			const config_items = this.loadConfigEnvelope(config_envelope);

			return config_items;

		}
	}

	/**
	 * Get the channel name.
	 * @returns {string} The name of the channel.
	 */
	getName() {
		return this._name;
	}

	/**
	 * @typedef {Object} ChaincodeInfo Object used internally to store chaincodes
	 *          names and versions found on this channel.
	 * @property {string} name - The name of the chaincode
	 * @property {string} version - The version of the chaincode
	 */

	/**
	 * Return the discovery results.
	 * Discovery results are only available if this channel has been initialized.
	 * If the results are too old, they will be refreshed
	 */
	async getDiscoveryResults() {
		if (this._discovery_results) {
			const allowed_age = sdk_utils.getConfigSetting('discovery-cache-age', 300000); //default is 5 minutes
			const now = Date.now();
			if (now - this._last_discover_timestamp > allowed_age) {
				return this.refresh();
			} else {
				return this._discovery_results;
			}
		} else {
			// not working with discovery or we have not been initialized
			throw new Error('This Channel has not been initialized or not initialized with discovery support');
		}
	}

	/**
	 * Refresh the channel's configuration.  The MSP configurations, peers,
	 * orderers, and endorsement plans will be queired from the peer using
	 * the Discover Service. The queries will be made to the peer used previously
	 * for discovery if the 'target' parameter is not provided.
	 *
	 * @param {DiscoveryRequest} request - {@link DiscoveryRequest}
	 * @return {DiscoveryResults} - The results of refreshing
	 */
	refresh(request) {
		if (!request) {
			request = this._last_refresh_request;
		}

		return this.initialize(request);
	}

	/**
	 * Get organization identifiers from the MSP's for this channel
	 * @returns {string[]} Array of MSP identifiers representing the channel's
	 *          participating organizations
	 */
	getOrganizations() {
		const method = 'getOrganizations';
		logger.debug('%s - start', method);
		const msps = this._msp_manager.getMSPs();
		const orgs = [];
		if (msps) {
			const keys = Object.keys(msps);
			for (const key in keys) {
				const msp = msps[keys[key]];
				const msp_org = {id: msp.getId()};
				logger.debug('%s - found %j', method, msp_org);
				orgs.push(msp_org);
			}
		}
		logger.debug('%s - orgs::%j', method, orgs);
		return orgs;
	}

	/**
	 * Set the MSP Manager for this channel. This utility method will
	 * not normally be use as the [initialize()]{@link Channel#initialize}
	 * method will read this channel's current configuration and reset
	 * MSPManager with the MSP's found in the channel configuration.
	 *
	 * @param {MSPManager} msp_manager - The msp manager for this channel
	 */
	setMSPManager(msp_manager) {
		this._msp_manager = msp_manager;
	}

	/**
	 * Get the MSP Manager for this channel
	 * @returns {MSPManager}
	 */
	getMSPManager() {
		return this._msp_manager;
	}

	/**
	 * Add the peer object to the channel object. A channel object can be optionally
	 * configured with a list of peer objects, which will be used when calling certain
	 * methods such as [sendInstantiateProposal()]{@link Channel#sendInstantiateProposal},
	 * [sendUpgradeProposal()]{@link Channel#sendUpgradeProposal},
	 * [sendTransactionProposal]{@link Channel#sendTransactionProposal}.
	 *
	 * @param {Peer} peer - An instance of the Peer class that has been initialized with URL
	 *        and other gRPC options such as TLS credentials and request timeout.
	 * @param {string} mspid - The mpsid of the organization this peer belongs.
	 * @param {string} mspid - The MSP this peer is using.
	 * @param {ChannelPeerRoles} roles - Optional. The roles this peer will perform
	 *        on this channel.  A role that is not defined will default to true
	 * @param {boolean} replace - If an orderer exist with the same name, replace
	 *        with this one.
	 */
	addPeer(peer, mspid, roles, replace) {
		const name = peer.getName();
		const check = this._channel_peers.get(name);
		if (check) {
			if (replace) {
				logger.debug('/n removing old peer  --name: %s --URL: %s', peer.getName(), peer.getUrl());

				this.removePeer(check);
			} else {
				const error = new Error();
				error.name = 'DuplicatePeer';
				error.message = 'Peer ' + name + ' already exists';
				logger.error(error.message);
				throw error;
			}
		}
		logger.debug('/n adding a new peer  --name: %s --URL: %s', peer.getName(), peer.getUrl());

		const channel_peer = new ChannelPeer(mspid, this, peer, roles);
		this._channel_peers.set(name, channel_peer);
	}

	/**
	 * Remove the peer object in the channel object's list of peers
	 * whose endpoint url property matches the url or name of the peer that is
	 * passed in.
	 *
	 * @param {Peer} peer - An instance of the Peer class.
	 */
	removePeer(peer) {
		this._channel_peers.delete(peer.getName());
	}

	/**
	 * This method will return a {@link ChannelPeer} instance if assigned to this
	 * channel. Peers that have been created by the {@link Client#newPeer}
	 * method and then added to this channel may be reference by the url if no
	 * name was provided in the options during the create.
	 * A {@link ChannelPeer} provides a reference to peer and channel event hub along
	 * with how this peer is being used on this channel.
	 *
	 * @param {string} name - The name of the peer
	 * @returns {ChannelPeer} The ChannelPeer instance.
	 */
	getPeer(name) {
		const channel_peer = this._channel_peers.get(name);

		if (!channel_peer) {
			throw new Error(util.format(PEER_NOT_ASSIGNED_MSG, name));
		}

		return channel_peer;
	}

	/**
	 * This method will return a {@link ChannelPeer}. This object holds a reference
	 * to the {@link Peer} and the {@link ChannelEventHub} objects and the attributes
	 * of how the peer is defined on the channel.
	 *
	 * @param {string} name - The name of the peer assigned to this channel
	 * @returns {ChannelPeer} The ChannelPeer instance
	 */
	getChannelPeer(name) {
		const channel_peer = this._channel_peers.get(name);

		if (!channel_peer) {
			throw new Error(util.format(PEER_NOT_ASSIGNED_MSG, name));
		}

		return channel_peer;
	}

	/**
	 * Returns a list of {@link ChannelPeer} assigned to this channel instance.
	 * A {@link ChannelPeer} provides a reference to peer and channel event hub along
	 * with how this peer is being used on this channel.
	 * @returns {ChannelPeer[]} The channel peer list on the channel.
	 */
	getPeers() {
		logger.debug('getPeers - list size: %s.', this._channel_peers.size);
		const peers = [];
		this._channel_peers.forEach((channel_peer) => {
			peers.push(channel_peer);
		});
		return peers;
	}

	/**
	 * Returns a list of {@link ChannelPeer} assigned to this channel instance.
	 * A {@link ChannelPeer} provides a reference to peer and channel event hub along
	 * with how this peer is being used on this channel.
	 * @returns {ChannelPeer[]} The channel peer list on the channel.
	 */
	getChannelPeers() {
		return this.getPeers();
	}

	/**
	 * Add the orderer object to the channel object, this is a client-side-only operation.
	 * An application may add more than one orderer object to the channel object, however
	 * the SDK only uses the first one in the list to send broadcast messages to the
	 * orderer backend.
	 *
	 * @param {Orderer} orderer - An instance of the Orderer class.
	 * @param {boolean} replace - If an orderer exist with the same name, replace
	 *        with this one.
	 */
	addOrderer(orderer, replace) {
		const name = orderer.getName();
		const check = this._orderers.get(name);
		if (check) {
			if (replace) {
				this.removeOrderer(check);
			} else {
				const error = new Error();
				error.name = 'DuplicateOrderer';
				error.message = 'Orderer ' + name + ' already exists';
				logger.error(error.message);
				throw error;
			}
		}
		this._orderers.set(name, orderer);
	}

	/**
	 * Remove the first orderer object in the channel object's list of orderers
	 * whose endpoint url property matches the url of the orderer that is
	 * passed in.
	 *
	 * @param {Orderer} orderer - An instance of the Orderer class.
	 */
	removeOrderer(orderer) {
		this._orderers.delete(orderer.getName());
	}

	/**
	 * This method will return a {@link Orderer} instance if assigned to this
	 * channel. Peers that have been created by the {@link Client#newOrderer}
	 * method and then added to this channel may be reference by the url if no
	 * name was provided in the options during the create.
	 *
	 * @param {string} name - The name or url of the orderer
	 * @returns {Orderer} The Orderer instance.
	 */
	getOrderer(name) {
		const orderer = this._orderers.get(name);

		if (!orderer) {
			throw new Error(util.format(ORDERER_NOT_ASSIGNED_MSG, name));
		}

		return orderer;
	}

	/**
	 * Returns the orderers of this channel object.
	 * @returns {Orderer[]} The list of orderers in the channel object
	 */
	getOrderers() {
		logger.debug('getOrderers - list size: %s.', this._orderers.size);
		const orderers = [];
		this._orderers.forEach((orderer) => {
			orderers.push(orderer);
		});
		return orderers;
	}

	/**
	 * Returns an {@link ChannelEventHub} object. An event hub object encapsulates the
	 * properties of an event stream on a peer node, through which the peer publishes
	 * notifications of blocks being committed in the channel's ledger.
	 * This method will create a new ChannelEventHub and not save a reference.
	 * Use the {getChannelEventHub} to reuse a ChannelEventHub.
	 *
	 * @param {Peer | string} peer A Peer instance or the name of a peer that has
	 *        been assigned to the channel.
	 * @returns {ChannelEventHub} The ChannelEventHub instance
	 */
	newChannelEventHub(peer) {
		const peers = this._getTargets(peer, Constants.NetworkConfig.EVENT_SOURCE_ROLE, true);
		// will only return one
		if (peers && peers.length > 0) {
			const channel_event_hub = new ChannelEventHub(this, peers[0]);
			return channel_event_hub;
		} else {
			throw new Error(util.format(PEER_NOT_ASSIGNED_MSG, peer));
		}
	}

	/**
	 * Returns an {@link ChannelEventHub} object. An event hub object encapsulates the
	 * properties of an event stream on a peer node, through which the peer publishes
	 * notifications of blocks being committed in the channel's ledger.
	 * This method will create a new ChannelEventHub if one does not exist.
	 *
	 * @param {string} name - The peer name associated with this channel event hub.
	 *        Use the {@link Peer#getName} method to get the name of a
	 *        peer instance that has been added to this channel.
	 * @returns {ChannelEventHub} - The ChannelEventHub associated with the peer.
	 */
	getChannelEventHub(name) {
		if (!(typeof name === 'string')) {
			throw new Error('"name" parameter must be a Peer name.');
		}
		const _channel_peer = this._channel_peers.get(name);
		if (!_channel_peer) {
			throw new Error(util.format(PEER_NOT_ASSIGNED_MSG, name));
		}

		return _channel_peer.getChannelEventHub();
	}

	/**
	 * Returns a list of {@link ChannelEventHub} based on the peers that are
	 * defined in this channel that are in the organization.
	 *
	 * @param {string} mspid - Optional - The mspid of an organization
	 * @returns {ChannelEventHub[]} An array of ChannelEventHub instances
	 */
	getChannelEventHubsForOrg(mspid) {
		const method = 'getChannelEventHubsForOrg';
		let _mspid = null;
		if (!mspid) {
			_mspid = this._clientContext.getMspid();
			logger.debug('%s - starting - using client mspid: %s', method, _mspid);
		} else {
			_mspid = mspid;
			logger.debug('%s - starting - mspid: %s', method, _mspid);
		}

		const channel_event_hubs = [];
		this._channel_peers.forEach((channel_peer) => {
			if (channel_peer.isInOrg(_mspid)) {
				if (channel_peer.isInRole(Constants.NetworkConfig.EVENT_SOURCE_ROLE)) {
					channel_event_hubs.push(channel_peer.getChannelEventHub());
				} else {
					logger.debug('%s - channel peer:%s is not an event source', method, channel_peer.getName());
				}
			}
		});

		return channel_event_hubs;
	}

	/**
	 * Returns a list of {@link Peer} that are
	 * defined in this channel that are in the named organization.
	 *
	 * @param {string} mspid - Optional - The name of an organization
	 * @returns {Peer[]} An array of Peer instances
	 */
	getPeersForOrg(mspid) {
		const method = 'getPeersForOrg';
		let _mspid = null;
		if (!mspid) {
			_mspid = this._clientContext._mspid;
			logger.debug('%s - starting - using client mspid: %s', method, _mspid);
		} else {
			_mspid = mspid;
			logger.debug('%s - starting - mspid: %s', method, _mspid);
		}

		const peers = [];
		this._channel_peers.forEach((channel_peer) => {
			if (channel_peer.isInOrg(_mspid)) {
				peers.push(channel_peer);
			}
		});

		return peers;
	}

	/**
	 * @typedef {Object} OrdererRequest
	 * @property {TransactionID} txId - Optional. Object with the transaction id and nonce
	 * @property {Orderer} orderer - Optional. The orderer instance or string name
	 *                     of the orderer to retrieve genesis block from
	 */

	/**
	 * A channel's first block is called the "genesis block". This block captures the
	 * initial channel configuration. For a peer node to join the channel, it must be
	 * provided the genesis block. This method must be called before calling
	 * [joinChannel()]{@link Channel#joinChannel}.
	 *
	 * @param {OrdererRequest} request - Optional - A transaction ID object
	 * @returns {Promise} A Promise for an encoded protobuf "Block"
	 */
	getGenesisBlock(request) {
		logger.debug('getGenesisBlock - start');

		if (!request) {
			request = {};
		}

		// verify that we have an orderer configured
		const orderer = this._clientContext.getTargetOrderer(request.orderer, this.getOrderers(), this._name);
		let signer = null;
		let tx_id = request.txId;
		if (!tx_id) {
			signer = this._clientContext._getSigningIdentity(true);
			tx_id = new TransactionID(signer, true);
		} else {
			signer = this._clientContext._getSigningIdentity(tx_id.isAdmin());
		}

		// now build the seek info, will be used once the channel is created
		// to get the genesis block back
		//   build start
		const seekSpecifiedStart = new _abProto.SeekSpecified();
		seekSpecifiedStart.setNumber(0);
		const seekStart = new _abProto.SeekPosition();
		seekStart.setSpecified(seekSpecifiedStart);

		//   build stop
		const seekSpecifiedStop = new _abProto.SeekSpecified();
		seekSpecifiedStop.setNumber(0);
		const seekStop = new _abProto.SeekPosition();
		seekStop.setSpecified(seekSpecifiedStop);

		// seek info with all parts
		const seekInfo = new _abProto.SeekInfo();
		seekInfo.setStart(seekStart);
		seekInfo.setStop(seekStop);
		seekInfo.setBehavior(_abProto.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY);

		// build the header for use with the seekInfo payload
		const seekInfoHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.DELIVER_SEEK_INFO,
			this._name,
			tx_id.getTransactionID(),
			this._initial_epoch,
			null,
			client_utils.buildCurrentTimestamp(),
			this._clientContext.getClientCertHash()
		);

		const seekHeader = client_utils.buildHeader(signer, seekInfoHeader, tx_id.getNonce());
		const seekPayload = new _commonProto.Payload();
		seekPayload.setHeader(seekHeader);
		seekPayload.setData(seekInfo.toBuffer());
		const seekPayloadBytes = seekPayload.toBuffer();

		const sig = signer.sign(seekPayloadBytes);
		const signature = Buffer.from(sig);

		// building manually or will get protobuf errors on send
		const envelope = {
			signature: signature,
			payload: seekPayloadBytes
		};

		return orderer.sendDeliver(envelope);
	}

	/*
	 * Internal use only
	 *
	 * @typedef {Object} DiscoveryRequest
	 * @property {Peer | string} target - Optional. A Peer object or Peer name that
	 *           will be asked to discovery information about this channel.
	 *           Default is the first peer assigned to this channel that has the
	 *           'discovery' role.
	 * @property {string[]} chaincodes - Optional. An Array of chaincodes to get
	 *           the endorsement target selection layouts
	 * @property {boolean} endpoint_names - Optional. To indicate if the names of
	 *           endpoints should be added to the return attributes of an end point.
	 *           Requesting the name will require that the endpoints (Peer and Orderer)
	 *           be added to this channel instance with the returned name.
	 * @property {boolean} initialize_msps - Optional. To indicate that the MSPs
	 *           discovered in this query should be added to this channel instance.
	 * @property {boolean} config - Optional. To indicate that the channel configuration
	 *           should be included in the discovery query.
	 * @property {boolean} local - Optonal. To indicate that the local endpoints
	 *           should be included in the discovery query.
	 */

	/**
	 * Send a request to a known peer to discover information about the fabric
	 * network.
	 *
	 * @param {DiscoveryRequest} request -
	 * @returns {DiscoveryResponse} The results of the discover
	 */
	async _discover(request) {
		const method = 'discover';
		const self = this;
		logger.debug('%s - start', method);
		const results = {};
		if (!request) {
			request = {};
		}
		const target_peer = this._getTargetForDiscovery(request.target);
		const signer = this._clientContext._getSigningIdentity(true); //use the admin if assigned
		const discovery_request = new _discoveryProto.Request();

		const authentication = new _discoveryProto.AuthInfo();
		authentication.setClientIdentity(signer.serialize());
		const cert_hash = this._clientContext.getClientCertHash(true);
		if (cert_hash) {
			authentication.setClientTlsCertHash(cert_hash);
		}
		discovery_request.setAuthentication(authentication);

		// be sure to add all entries to this array before setting into the
		// grpc object
		const queries = [];

		// if doing local it will be index 0 of the results
		if (request.local) {
			const query = new _discoveryProto.Query();
			queries.push(query);

			const local_peers = new _discoveryProto.LocalPeerQuery();
			query.setLocalPeers(local_peers);
			logger.debug('%s - adding local peers query', method);
		}

		if (request.config) {
			let query = new _discoveryProto.Query();
			queries.push(query);
			query.setChannel(this.getName());

			const config_query = new _discoveryProto.ConfigQuery();
			query.setConfigQuery(config_query);
			logger.debug('%s - adding config query', method);

			query = new _discoveryProto.Query();
			queries.push(query);
			query.setChannel(this.getName());

			const peer_query = new _discoveryProto.PeerMembershipQuery();
			query.setPeerQuery(peer_query);
			logger.debug('%s - adding channel peers query', method);
		}

		// add a chaincode query to get endorsement layouts if chaincodeId is set
		if (request.chaincodes && request.chaincodes.length > 0) {
			const query = new _discoveryProto.Query();
			queries.push(query);
			query.setChannel(this.getName());

			const interests = [];
			for (const index in request.chaincodes) {
				const chaincodes = [];
				const chaincode_name = request.chaincodes[index];
				const chaincode_call = new _discoveryProto.ChaincodeCall();
				chaincode_call.setName(chaincode_name);
				chaincodes.push(chaincode_call);
				const interest = new _discoveryProto.ChaincodeInterest();
				interest.setChaincodes(chaincodes);
				interests.push(interest);
			}

			const cc_query = new _discoveryProto.ChaincodeQuery();
			cc_query.setInterests(interests);
			query.setCcQuery(cc_query);
			logger.debug('%s - adding chaincode query', method);
		}

		// be sure to set the array after completely building it
		discovery_request.setQueries(queries);

		// build up the outbound request object
		const payload = discovery_request.toBuffer();
		const signature = Buffer.from(signer.sign(payload));
		const signed_request = {
			payload: payload,
			signature: signature
		};

		const response = await target_peer.sendDiscovery(signed_request);
		logger.debug('%s - processing discovery response', method);
		if (response && response.results) {
			let error_msg = null;
			logger.debug('%s - parse discovery response', method);
			for (const index in response.results) {
				const result = response.results[index];
				if (!result) {
					error_msg = 'Discover results are missing';
					break;
				} else if (result.result === 'error') {
					logger.error('Channel:%s received discovery error:%s', self.getName(), result.error.content);
					error_msg = result.error.content;
					break;
				} else {
					logger.debug('%s - process results', method);
					if (result.config_result) {
						const config = self._processDiscoveryConfigResults(result.config_result);
						results.msps = config.msps;
						results.orderers = config.orderers;
					}
					if (result.members) {
						if (request.local && index === 0) {
							results.local_peers = self._processDiscoveryMembershipResults(result.members);
						} else {
							results.peers_by_org = self._processDiscoveryMembershipResults(result.members);
						}
					}
					if (result.cc_query_res) {
						results.endorsement_targets = self._processDiscoveryChaincodeResults(result.cc_query_res);
					}
					logger.debug('%s - completed processing results', method);
				}
			}

			if (error_msg) {
				throw Error('Channel:' + self.getName() + ' Discovery error:' + error_msg);
			} else {

				return results;
			}
		} else {
			throw new Error('Discovery has failed to return results');
		}
	}

	_processDiscoveryChaincodeResults(q_chaincodes) {
		const method = '_processDiscoveryChaincodeResults';
		logger.debug('%s - start', method);
		const by_chaincode = {};
		if (q_chaincodes && q_chaincodes.content) {
			if (Array.isArray(q_chaincodes.content)) {
				for (const index in q_chaincodes.content) {
					const q_endors_desc = q_chaincodes.content[index];
					const endorsement_descriptor = {};
					by_chaincode[q_endors_desc.chaincode] = endorsement_descriptor;

					// GROUPS
					endorsement_descriptor.groups = {};
					for (const group_name in q_endors_desc.endorsers_by_groups) {
						logger.debug('%s - found group: %s', method, group_name);
						const group = {};
						group.peers = this._processPeers(q_endors_desc.endorsers_by_groups[group_name].peers);
						//all done with this group
						endorsement_descriptor.groups[group_name] = group;
					}

					// LAYOUTS
					endorsement_descriptor.layouts = [];
					for (const index in q_endors_desc.layouts) {
						const q_layout = q_endors_desc.layouts[index];
						const layout = {};
						for (const group_name in q_layout.quantities_by_group) {
							layout[group_name] = q_layout.quantities_by_group[group_name];
						}
						logger.debug('%s - layout :%j', method, layout);
						endorsement_descriptor.layouts.push(layout);
					}
				}
			}
		}

		return by_chaincode;
	}

	_processDiscoveryConfigResults(q_config) {
		const method = '_processDiscoveryConfigResults';
		logger.debug('%s - start', method);
		const config = {};
		if (q_config) try {
			if (q_config.msps) {
				config.msps = {};
				for (const id in q_config.msps) {
					logger.debug('%s - found organization %s', method, id);
					const q_msp = q_config.msps[id];
					const msp_config = {
						id: id,
						orgs: q_msp.organizational_unit_identifiers,
						rootCerts: sdk_utils.convertBytetoString(q_msp.root_certs),
						intermediateCerts: sdk_utils.convertBytetoString(q_msp.intermediate_certs),
						admins: sdk_utils.convertBytetoString(q_msp.admins),
						tls_root_certs: sdk_utils.convertBytetoString(q_msp.tls_root_certs),
						tls_intermediate_certs: sdk_utils.convertBytetoString(q_msp.tls_intermediate_certs)
					};
					config.msps[id] = msp_config;
				}
			}
			/*
			"orderers":{"OrdererMSP":{"endpoint":[{"host":"orderer.example.com","port":7050}]}}}
			*/
			if (q_config.orderers) {
				config.orderers = {};
				for (const mspid in q_config.orderers) {
					logger.debug('%s - found orderer org: ', method, mspid);
					config.orderers[mspid] = {};
					config.orderers[mspid].endpoints = [];
					for (const index in q_config.orderers[mspid].endpoint) {
						config.orderers[mspid].endpoints.push(q_config.orderers[mspid].endpoint[index]);
					}
				}
			}
		} catch (err) {
			logger.error('Problem with discovery config: %s', err);
		}

		return config;
	}

	_processDiscoveryMembershipResults(q_members) {
		const method = '_processDiscoveryChannelMembershipResults';
		logger.debug('%s - start', method);
		const peers_by_org = {};
		if (q_members && q_members.peers_by_org) {
			for (const mspid in q_members.peers_by_org) {
				logger.debug('%s - found org:%s', method, mspid);
				peers_by_org[mspid] = {};
				peers_by_org[mspid].peers = this._processPeers(q_members.peers_by_org[mspid].peers);
			}
		}
		return peers_by_org;
	}

	_processPeers(q_peers) {
		const method = '_processPeers';
		const peers = [];
		q_peers.forEach((q_peer) => {
			const peer = {};
			// IDENTITY
			const q_identity = _identityProto.SerializedIdentity.decode(q_peer.identity);
			peer.mspid = q_identity.mspid;

			// MEMBERSHIP
			const q_membership_message = _gossipProto.GossipMessage.decode(q_peer.membership_info.payload);
			peer.endpoint = q_membership_message.alive_msg.membership.endpoint;
			logger.debug('%s - found peer :%s', method, peer.endpoint);

			// STATE
			if (q_peer.state_info) {
				const message_s = _gossipProto.GossipMessage.decode(q_peer.state_info.payload);
				if (message_s && message_s.state_info && message_s.state_info.properties && message_s.state_info.properties.ledger_height) {
					peer.ledger_height = Long.fromValue(message_s.state_info.properties.ledger_height);
				} else {
					logger.debug('%s - did not find ledger_height', method);
					peer.ledger_height = Long.fromValue(0);
				}
				logger.debug('%s - found ledger_height :%s', method, peer.ledger_height);
				peer.chaincodes = [];
				for (const index in message_s.state_info.properties.chaincodes) {
					const q_chaincode = message_s.state_info.properties.chaincodes[index];
					const chaincode = {};
					chaincode.name = q_chaincode.getName();
					chaincode.version = q_chaincode.getVersion();
					//TODO metadata ?
					logger.debug('%s - found chaincode :%j', method, chaincode);
					peer.chaincodes.push(chaincode);
				}
			}

			//all done with this peer
			peers.push(peer);
		});

		return peers;
	}

	_buildOrdererName(msp_id, host, port, msps, request) {
		const method = '_buildOrdererName';
		logger.debug('%s - start', method);

		const name = host + ':' + port;
		const url = this._buildUrl(host, port, request);
		let found = null;
		this._orderers.forEach((orderer) => {
			if (orderer.getUrl() === url) {
				logger.debug('%s - found existing orderer %s', method, url);
				found = orderer;
			}
		});
		if (!found) {
			if (msps[msp_id]) {
				logger.debug('%s - create a new orderer %s', method, url);
				found = new Orderer(url, this._buildOptions(name, url, host, msps[msp_id]));
				this.addOrderer(found, true);
			} else {
				throw new Error('No TLS cert information available');
			}
		}

		return found.getName();
	}

	_buildPeerName(endpoint, msp_id, msps, request) {
		const method = '_buildPeerName';
		logger.debug('%s - start', method);

		const name = endpoint;
		const host_port = endpoint.split(':');
		const url = this._buildUrl(host_port[0], host_port[1], request);
		let found = null;
		this._channel_peers.forEach((peer) => {
			if (peer.getUrl() === url) {
				logger.debug('%s - found existing peer %s', method, url);
				found = peer;
			}
		});
		if (!found) {
			if (msp_id && msps && msps[msp_id]) {
				logger.debug('%s - create a new peer %s', method, url);
				found = new Peer(url, this._buildOptions(name, url, host_port[0], msps[msp_id]));
				this.addPeer(found, msp_id, null, true);
			} else {
				throw new Error('No TLS cert information available');
			}
		}

		return found.getName();
	}

	_buildUrl(hostname, port, request) {
		const method = '_buildUrl';
		logger.debug('%s - start', method);

		let t_hostname = hostname;

		// endpoints may be running in containers on the local system
		if (request && request.asLocalhost) {
			t_hostname = 'localhost';
		}

		const protocol = sdk_utils.getConfigSetting('discovery-protocol', 'grpcs');
		const url = protocol + '://' + t_hostname + ':' + port;

		return url;
	}

	_buildOptions(name, url, host, msp) {
		const method = '_buildOptions';
		logger.debug('%s - start', method);

		const caroots = this._buildTlsRootCerts(msp);
		const opts = {
			'pem': caroots,
			'ssl-target-name-override': host,
			'name': name
		};
		this._clientContext.addTlsClientCertAndKey(opts);

		return opts;
	}

	_buildTlsRootCerts(msp) {
		let caroots = '';
		if (msp.tls_root_certs) {
			caroots = caroots + msp.tls_root_certs;
		}
		if (msp.tls_intermediate_certs) {
			caroots = caroots + msp.tls_intermediate_certs;
		}

		return caroots;
	}

	/**
	 * A protobuf message that gets returned by endorsing peers on proposal requests.
	 * The peer node runs the target chaincode, as designated by the proposal, and
	 * decides on whether to endorse the proposal or not, and sends back the endorsement
	 * result along with the [read and write sets]{@link http://hyperledger-fabric.readthedocs.io/en/latest/arch-deep-dive.html?highlight=readset#the-endorsing-peer-simulates-a-transaction-and-produces-an-endorsement-signature}
	 * inside the proposal response message.
	 *
	 * @typedef {Object} ProposalResponse
	 * @property {number} version
	 * @property {Timestamp} timestamp - Time the proposal was created by the submitter
	 * @property {Response} response
	 * @property {byte[]} payload - The payload of the response. It is the encoded bytes of
	 *                              the "ProposalResponsePayload" protobuf message
	 * @property {Endorsement} endorsement - The endorsement of the proposal, basically the
	 *                                       endorser's signature over the payload
	 */

	/**
	 * A response message indicating whether the endorsement of the proposal was successful
	 *
	 * @typedef {Object} Response
	 * @property {number} status - Status code. Follows [HTTP status code definitions]{@link https://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html}
	 * @property {string} message - A message associated with the response status code
	 * @property {byte[]} payload - A payload that can be used to include metadata with this response
	 */

	/**
	 * @typedef {Object} JoinChannelRequest
	 * @property {Peer[]} targets - Optional. An array of Peer objects or Peer names that will
	 *                              be asked to join this channel. When using Peer names or left
	 *                              empty (use default targets) there must be a loaded network
	 *                              configuration.
	 *                              See [loadFromConfig()]{@link Client#loadFromConfig}
	 * @property {byte[]} block - The encoded bytes of the channel's genesis block.
	 *                            See [getGenesisBlock()]{@link Channel#getGenesisBlock} method
	 * @property {TransactionID} txId - Required. TransactionID object with the transaction id and nonce
	 */

	/**
	 * For a peer node to become part of a channel, it must be sent the genesis
	 * block, as explained [here]{@link Channel#getGenesisBlock}. This method
	 * sends a join channel proposal to one or more endorsing peers.
	 *
	 * @param {JoinChannelRequest} request
	 * @param {Number} timeout - A number indicating milliseconds to wait on the
	 *                              response before rejecting the promise with a
	 *                              timeout error. This overrides the default timeout
	 *                              of the {@link Peer} instance(s) and the global timeout in the config settings.
	 * @returns {Promise} A Promise for an array of {@link ProposalResponse} from the target peers
	 */
	joinChannel(request, timeout) {
		logger.debug('joinChannel - start');
		let errorMsg = null;

		// verify that we have targets (Peers) to join this channel
		// defined by the caller
		if (!request) {
			errorMsg = 'Missing all required input request parameters';
		}
		// verify that we have transaction id
		else if (!request.txId) {
			errorMsg = 'Missing txId input parameter with the required transaction identifier';
		}
		else if (!request.block) {
			errorMsg = 'Missing block input parameter with the required genesis block';
		}

		if (errorMsg) {
			logger.error('joinChannel - error ' + errorMsg);
			throw new Error(errorMsg);
		}

		const targets = this._getTargets(request.targets, 'ALL ROLES');
		const signer = this._clientContext._getSigningIdentity(request.txId.isAdmin());
		const chaincodeInput = new _ccProto.ChaincodeInput();
		const args = [];
		args.push(Buffer.from('JoinChain', 'utf8'));
		args.push(request.block.toBuffer());

		chaincodeInput.setArgs(args);

		const chaincodeID = new _ccProto.ChaincodeID();
		chaincodeID.setName(Constants.CSCC);

		const chaincodeSpec = new _ccProto.ChaincodeSpec();
		chaincodeSpec.setType(_ccProto.ChaincodeSpec.Type.GOLANG);
		chaincodeSpec.setChaincodeId(chaincodeID);
		chaincodeSpec.setInput(chaincodeInput);

		const channelHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.ENDORSER_TRANSACTION,
			'',
			request.txId.getTransactionID(),
			null, //no epoch
			Constants.CSCC,
			client_utils.buildCurrentTimestamp(),
			this._clientContext.getClientCertHash()
		);

		const header = client_utils.buildHeader(signer, channelHeader, request.txId.getNonce());
		const proposal = client_utils.buildProposal(chaincodeSpec, header);
		const signed_proposal = client_utils.signProposal(signer, proposal);

		return client_utils.sendPeersProposal(targets, signed_proposal, timeout).catch((err) => {
			logger.error('joinChannel - Failed Proposal. Error: %s', err.stack ? err.stack : err);
			return Promise.reject(err);
		});
	}

	/**
	 * Asks the peer for the current (latest) configuration block for this channel.
	 * @param {string | Peer} target - Optional. The peer to be used to make the
	 *        request.
	 * @returns {Promise} A Promise for a {@link ConfigEnvelope} object containing the configuration items.
	 */
	async getChannelConfig(target, timeout) {
		const method = 'getChannelConfig';
		logger.debug('%s - start for channel %s', method, this._name);
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(true);
		const tx_id = new TransactionID(signer, true);
		const request = {
			targets: targets,
			chaincodeId: Constants.CSCC,
			txId: tx_id,
			signer: signer,
			fcn: 'GetConfigBlock',
			args: [this._name]
		};
		request.targets = this._getTargets(request.targets, Constants.NetworkConfig.ENDORSING_PEER_ROLE);

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, timeout);
		const responses = results[0];
		// const proposal = results[1];
		logger.debug('%s - results received', method);
		if (responses && Array.isArray(responses)) {
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			else if (response.response && response.response.payload && response.response.status === 200) {
				const block = _commonProto.Block.decode(response.response.payload);
				const envelope = _commonProto.Envelope.decode(block.data.data[0]);
				const payload = _commonProto.Payload.decode(envelope.payload);
				const config_envelope = _configtxProto.ConfigEnvelope.decode(payload.data);
				return config_envelope;
			}
			else {
				logger.error('%s - unknown response ::%s', method, response);
				throw new Error(response);
			}
		}
		throw new Error('Payload results are missing from the get channel config');
	}

	/**
	 * Asks the orderer for the current (latest) configuration block for this channel.
	 * This is similar to [getGenesisBlock()]{@link Channel#getGenesisBlock}, except
	 * that instead of getting block number 0 it gets the latest block that contains
	 * the channel configuration, and only returns the decoded {@link ConfigEnvelope}.
	 *
	 * @returns {Promise} A Promise for a {@link ConfigEnvelope} object containing the configuration items.
	 */
	async getChannelConfigFromOrderer() {
		const method = 'getChannelConfigFromOrderer';
		logger.debug('%s - start for channel %s', method, this._name);

		const self = this;
		const orderer = this._clientContext.getTargetOrderer(null, this.getOrderers(), this._name);

		const signer = this._clientContext._getSigningIdentity(true);
		let txId = new TransactionID(signer, true);

		// seek the latest block
		let seekSpecifiedStart = new _abProto.SeekNewest();
		let seekStart = new _abProto.SeekPosition();
		seekStart.setNewest(seekSpecifiedStart);

		let seekSpecifiedStop = new _abProto.SeekNewest();
		let seekStop = new _abProto.SeekPosition();
		seekStop.setNewest(seekSpecifiedStop);

		// seek info with all parts
		let seekInfo = new _abProto.SeekInfo();
		seekInfo.setStart(seekStart);
		seekInfo.setStop(seekStop);
		seekInfo.setBehavior(_abProto.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY);

		// build the header for use with the seekInfo payload
		let seekInfoHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.DELIVER_SEEK_INFO,
			self._name,
			txId.getTransactionID(),
			self._initial_epoch,
			null,
			client_utils.buildCurrentTimestamp(),
			this._clientContext.getClientCertHash()
		);

		let seekHeader = client_utils.buildHeader(signer, seekInfoHeader, txId.getNonce());
		let seekPayload = new _commonProto.Payload();
		seekPayload.setHeader(seekHeader);
		seekPayload.setData(seekInfo.toBuffer());
		let seekPayloadBytes = seekPayload.toBuffer();

		let signature = Buffer.from(signer.sign(seekPayloadBytes));

		// building manually or will get protobuf errors on send
		let envelope = {
			signature: signature,
			payload: seekPayloadBytes
		};
		// This will return us a block
		let block = await orderer.sendDeliver(envelope);
		logger.debug('%s - good results from seek block ', method); // :: %j',results);
		// verify that we have the genesis block
		if (block) {
			logger.debug('%s - found latest block', method);
		}
		else {
			logger.error('%s - did not find latest block', method);
			throw new Error('Failed to retrieve latest block', method);
		}

		logger.debug('%s - latest block is block number %s', block.header.number);
		// get the last config block number
		const metadata = _commonProto.Metadata.decode(block.metadata.metadata[_commonProto.BlockMetadataIndex.LAST_CONFIG]);
		const last_config = _commonProto.LastConfig.decode(metadata.value);
		logger.debug('%s - latest block has config block of %s', method, last_config.index);

		txId = new TransactionID(signer);

		// now build the seek info to get the block called out
		// as the latest config block
		seekSpecifiedStart = new _abProto.SeekSpecified();
		seekSpecifiedStart.setNumber(last_config.index);
		seekStart = new _abProto.SeekPosition();
		seekStart.setSpecified(seekSpecifiedStart);

		//   build stop
		seekSpecifiedStop = new _abProto.SeekSpecified();
		seekSpecifiedStop.setNumber(last_config.index);
		seekStop = new _abProto.SeekPosition();
		seekStop.setSpecified(seekSpecifiedStop);

		// seek info with all parts
		seekInfo = new _abProto.SeekInfo();
		seekInfo.setStart(seekStart);
		seekInfo.setStop(seekStop);
		seekInfo.setBehavior(_abProto.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY);
		//logger.debug('initializeChannel - seekInfo ::' + JSON.stringify(seekInfo));

		// build the header for use with the seekInfo payload
		seekInfoHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.DELIVER_SEEK_INFO,
			self._name,
			txId.getTransactionID(),
			self._initial_epoch,
			null,
			client_utils.buildCurrentTimestamp(),
			self._clientContext.getClientCertHash()
		);

		seekHeader = client_utils.buildHeader(signer, seekInfoHeader, txId.getNonce());
		seekPayload = new _commonProto.Payload();
		seekPayload.setHeader(seekHeader);
		seekPayload.setData(seekInfo.toBuffer());
		seekPayloadBytes = seekPayload.toBuffer();

		signature = Buffer.from(signer.sign(seekPayloadBytes));

		// building manually or will get protobuf errors on send
		envelope = {
			signature: signature,
			payload: seekPayloadBytes
		};
		// this will return us a block
		block = await orderer.sendDeliver(envelope);
		if (!block) {
			throw new Error('Config block was not found');
		}
		// lets have a look at the block
		logger.debug('%s -  config block number ::%s  -- numberof tx :: %s', method, block.header.number, block.data.data.length);
		if (block.data.data.length !== 1) {
			throw new Error('Config block must only contain one transaction');
		}
		envelope = _commonProto.Envelope.decode(block.data.data[0]);
		const payload = _commonProto.Payload.decode(envelope.payload);
		const channel_header = _commonProto.ChannelHeader.decode(payload.header.channel_header);
		if (channel_header.type !== _commonProto.HeaderType.CONFIG) {
			throw new Error(`Block must be of type "CONFIG" (${_commonProto.HeaderType.CONFIG}), but got "${channel_header.type}" instead`);
		}

		const config_envelope = _configtxProto.ConfigEnvelope.decode(payload.data);

		// send back the envelope
		return config_envelope;
	}

	/*
	 * Utility method to load this channel with configuration information
	 * from an Envelope that contains a Configuration
	 * @param {byte[]} the envelope with the configuration update items
	 * @see /protos/common/configtx.proto
	 */
	loadConfigUpdateEnvelope(data) {
		logger.debug('loadConfigUpdateEnvelope - start');
		const envelope = _commonProto.Envelope.decode(data);
		const payload = _commonProto.Payload.decode(envelope.payload);
		const channel_header = _commonProto.ChannelHeader.decode(payload.header.channel_header);
		if (channel_header.type != _commonProto.HeaderType.CONFIG_UPDATE) {
			return new Error('Data must be of type "CONFIG_UPDATE"');
		}

		const config_update_envelope = _configtxProto.ConfigUpdateEnvelope.decode(payload.data);
		return this.loadConfigUpdate(config_update_envelope.config_update);
	}

	loadConfigUpdate(config_update_bytes) {
		const config_update = _configtxProto.ConfigUpdate.decode(config_update_bytes);
		logger.debug('loadConfigData - channel ::' + config_update.channel_id);

		const read_group = config_update.read_set;
		const write_group = config_update.write_set;

		const config_items = {};
		config_items.msps = []; //save all the MSP's found
		config_items['anchor-peers'] = []; //save all the MSP's found
		config_items.orderers = [];
		config_items['kafka-brokers'] = [];
		config_items.settings = {};
		config_items.versions = {};
		config_items.versions.read_group = {};
		config_items.versions.write_group = {};

		loadConfigGroup(config_items, config_items.versions.read_group, read_group, 'read_set', null, true, false);
		// do the write_set second so they update anything in the read set
		loadConfigGroup(config_items, config_items.versions.write_group, write_group, 'write_set', null, true, false);
		this._msp_manager.loadMSPs(config_items.msps);
		this._anchor_peers = config_items.anchor_peers;

		//TODO should we create orderers and endorsing peers
		return config_items;
	}

	/*
	 * Utility method to load this channel with configuration information
	 * from a Configuration block
	 * @param {ConfigEnvelope} the envelope with the configuration items
	 * @see /protos/common/configtx.proto
	 */
	loadConfigEnvelope(config_envelope) {
		logger.debug('loadConfigEnvelope - start');

		const group = config_envelope.config.channel_group;

		const config_items = {};
		config_items.msps = []; //save all the MSP's found
		config_items['anchor-peers'] = []; //save all the MSP's found
		config_items.orderers = [];
		config_items['kafka-brokers'] = [];
		config_items.versions = {};
		config_items.versions.channel = {};

		loadConfigGroup(config_items, config_items.versions.channel, group, 'base', null, true, true);
		this._msp_manager.loadMSPs(config_items.msps);
		this._anchor_peers = config_items.anchor_peers;

		//TODO should we create orderers and endorsing peers
		return config_items;
	}

	/**
	 * @typedef {Object} BlockchainInfo
	 * @property {number} height - How many blocks exist on the channel's ledger
	 * @property {byte[]} currentBlockHash - A block hash is calculated by hashing over the concatenated
	 *                                       ASN.1 encoded bytes of: the block number, previous block hash,
	 *                                       and current block data hash. It's the chain of the block
	 *                                       hashs that guarantees the immutability of the ledger
	 * @property {byte[]} previousBlockHash - The block hash of the previous block.
	 */

	/**
	 * Queries for various useful information on the state of the Channel
	 * (height, known peers).
	 *
	 * @param {Peer} target - Optional. The peer that is the target for this query.  If no target is passed,
	 *                        the query will use the first peer that was added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call to the peer.
	 * @returns {Promise} A Promise for a {@link BlockchainInfo} object with blockchain height,
	 *                        current block hash and previous block hash.
	 */
	async queryInfo(target, useAdmin) {
		logger.debug('queryInfo - start');
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const tx_id = new TransactionID(signer, useAdmin);
		const request = {
			targets: targets,
			chaincodeId: Constants.QSCC,
			txId: tx_id,
			signer: signer,
			fcn: 'GetChainInfo',
			args: [this._name]
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		if (responses && Array.isArray(responses)) {
			logger.debug('queryInfo - got responses=' + responses.length);
			//will only be one response as we are only querying the primary peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response && response.response.status && response.response.status === 200) {
				logger.debug('queryInfo - response status %d:', response.response.status);
				return _ledgerProto.BlockchainInfo.decode(response.response.payload);
			} else if (response.response && response.response.status) {
				// no idea what we have, lets fail it and send it back
				throw new Error(response.response.message);
			}
		}
		throw new Error('Payload results are missing from the query channel info');
	}

	/**
	 * Queries the ledger on the target peer for a Block TransactionID.
	 *
	 * @param {string} tx_id - The TransactionID of the Block in question.
	 * @param {Peer} target - Optional. The peer to send the query to. If no target is passed,
	 *                        the query is sent to the first peer that was added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call to the peer.
	 * @param {boolean} skipDecode - Optional. If true, this function returns an encoded block.
	 * @returns {Promise} A Promise for a {@link Block} matching the tx_id, fully decoded into an object.
	 */
	async queryBlockByTxID(tx_id, target, useAdmin, skipDecode) {
		logger.debug('queryBlockByTxID - start');
		if (!tx_id || !(typeof tx_id === 'string')) {
			throw new Error('tx_id as string is required');
		}

		const args = [this._name, tx_id];
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);

		const request = {
			targets,
			chaincodeId: Constants.QSCC,
			txId: new TransactionID(signer, useAdmin),
			fcn: 'GetBlockByTxID',
			args
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		if (responses && Array.isArray(responses)) {
			logger.debug('queryBlockByTxID - got response', responses.length);
			//will only be one response as we are only querying the primary peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response && response.response.status && response.response.status === 200) {
				logger.debug('queryBlockByTxID - response status %d:', response.response.status);
				if (skipDecode) {
					return response.response.payload;
				} else {
					const block = BlockDecoder.decode(response.response.payload);
					logger.debug('queryBlockByTxID - looking at block :: %s', block.header.number);
					return block;
				}
			} else if (response.response && response.response.status) {
				// no idea what we have, lets fail it and send it back
				throw new Error(response.response.message);
			}
		}
		throw new Error('Payload results are missing from the query');
	}

	/**
	 * Queries the ledger on the target peer for a Block by block hash.
	 *
	 * @param {byte[]} blockHash of the Block in question.
	 * @param {Peer} target - Optional. The peer to send the query to. If no target is passed,
	 *                        the query is sent to the first peer that was added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call to the peer.
	 * @param {boolean} skipDecode - Optional. If true, this function returns an encoded block.
	 * @returns {Promise} A Promise for a {@link Block} matching the hash, fully decoded into an object.
	 */
	async queryBlockByHash(blockHash, target, useAdmin, skipDecode) {
		logger.debug('queryBlockByHash - start');
		if (!blockHash) {
			throw new Error('Blockhash bytes are required');
		}
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const txId = new TransactionID(signer, useAdmin);
		const request = {
			targets: targets,
			chaincodeId: Constants.QSCC,
			txId: txId,
			signer: signer,
			fcn: 'GetBlockByHash',
			args: [this._name],
			argbytes: blockHash
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		logger.debug('queryBlockByHash - got response');
		if (responses && Array.isArray(responses)) {
			//will only be one response as we are only querying the primary peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response && response.response.status && response.response.status === 200) {
				logger.debug('queryBlockByHash - response status %d:', response.response.status);
				if (skipDecode) {
					return response.response.payload;
				} else {
					const block = BlockDecoder.decode(response.response.payload);
					logger.debug('queryBlockByHash - looking at block :: %s', block.header.number);
					return block;
				}
			} else if (response.response && response.response.status) {
				// no idea what we have, lets fail it and send it back
				throw new Error(response.response.message);
			}
		}
		throw new Error('Payload results are missing from the query');
	}

	/**
	 * Queries the ledger on the target peer for Block by block number.
	 *
	 * @param {number} blockNumber - The number of the Block in question.
	 * @param {Peer} target - Optional. The peer to send this query to. If no target is passed,
	 *                        the query is sent to the first peer that was added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call to the peer.
	 * @param {boolean} skipDecode - Optional. If true, this function returns an encoded block.
	 * @returns {Promise} A Promise for a {@link Block} at the blockNumber slot in the ledger, fully decoded into an object.
	 */
	async queryBlock(blockNumber, target, useAdmin, skipDecode) {
		logger.debug('queryBlock - start blockNumber %s', blockNumber);
		let block_number = null;
		if (Number.isInteger(blockNumber) && blockNumber >= 0) {
			block_number = blockNumber.toString();
		} else {
			throw new Error('Block number must be a positive integer');
		}
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const txId = new TransactionID(signer, useAdmin);
		const request = {
			targets: targets,
			chaincodeId: Constants.QSCC,
			txId: txId,
			signer: signer,
			fcn: 'GetBlockByNumber',
			args: [this._name, block_number]
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		logger.debug('queryBlock - got response');
		if (responses && Array.isArray(responses)) {
			//will only be one response as we are only querying the primary peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response && response.response.status && response.response.status === 200) {
				logger.debug('queryBlock - response status %d:', response.response.status);
				if (skipDecode) {
					return response.response.payload;
				} else {
					const block = BlockDecoder.decode(response.response.payload);
					logger.debug('queryBlock - looking at block :: %s', block.header.number);
					return block;
				}
			} else if (response.response && response.response.status) {
				// no idea what we have, lets fail it and send it back
				throw new Error(response.response.message);
			}
		}
		throw new Error('Payload results are missing from the query');
	}

	/**
	 * Queries the ledger on the target peer for Transaction by id.
	 *
	 * @param {string} tx_id - The id of the transaction
	 * @param {Peer} target - Optional. The peer to send this query to. If no target is passed,
	 *                        the query is sent to the first peer that was added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call to the peer.
	 * @param {boolean} skipDecode - Optional. If true, this function returns an encoded transaction.
	 * @returns {Promise} A Promise for a fully decoded {@link ProcessedTransaction} object.
	 */
	async queryTransaction(tx_id, target, useAdmin, skipDecode) {
		logger.debug('queryTransaction - start transactionID %s', tx_id);
		if (tx_id) {
			tx_id = tx_id.toString();
		} else {
			throw new Error('Missing "tx_id" parameter');
		}
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const txId = new TransactionID(signer, useAdmin);
		const request = {
			targets: targets,
			chaincodeId: Constants.QSCC,
			txId: txId,
			signer: signer,
			fcn: 'GetTransactionByID',
			args: [this._name, tx_id]
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		logger.debug('queryTransaction - got response');
		if (responses && Array.isArray(responses)) {
			//will only be one response as we are only querying the primary peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response && response.response.status && response.response.status === 200) {
				logger.debug('queryTransaction - response status :: %d', response.response.status);
				if (skipDecode) {
					return response.response.payload;
				} else {
					return BlockDecoder.decodeTransaction(response.response.payload);
				}
			} else if (response.response && response.response.status) {
				// no idea what we have, lets fail it and send it back
				throw new Error(response.response.message);
			}

		}
		throw new Error('Payload results are missing from the query');
	}

	/**
	 * Queries the ledger on the target peer for instantiated chaincodes on this channel.
	 *
	 * @param {Peer} target - Optional. The peer to send this query to. If no
	 *        target is passed, the query is sent to the first peer that was
	 *        added to the channel object.
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials
	 *        should be used in making this call to the peer. An administrative
	 *        identity must have been loaded by network configuration or by
	 *        using the 'setAdminSigningIdentity' method.
	 * @returns {Promise} A Promise for a fully decoded {@link ChaincodeQueryResponse} object.
	 */
	async queryInstantiatedChaincodes(target, useAdmin) {
		logger.debug('queryInstantiatedChaincodes - start');
		const targets = this._getTargetForQuery(target);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const txId = new TransactionID(signer, useAdmin);
		const request = {
			targets: targets,
			chaincodeId: Constants.LSCC,
			txId: txId,
			signer: signer,
			fcn: 'getchaincodes',
			args: []
		};

		const results = await Channel.sendTransactionProposal(request, this._name, this._clientContext, null);
		const responses = results[0];
		logger.debug('queryInstantiatedChaincodes - got response');
		if (responses && Array.isArray(responses)) {
			//will only be one response as we are only querying one peer
			if (responses.length > 1) {
				throw new Error('Too many results returned');
			}
			const response = responses[0];
			if (response instanceof Error) {
				throw response;
			}
			if (response.response) {
				if (response.response.status === 200) {
					logger.debug('queryInstantiatedChaincodes - response status :: %d', response.response.status);
					const queryTrans = _queryProto.ChaincodeQueryResponse.decode(response.response.payload);
					logger.debug('queryInstantiatedChaincodes - ProcessedTransaction.chaincodeInfo.length :: %s', queryTrans.chaincodes.length);
					for (const chaincode of queryTrans.chaincodes) {
						logger.debug('queryInstantiatedChaincodes - name %s, version %s, path %s', chaincode.name, chaincode.version, chaincode.path);
					}
					return queryTrans;
				} else {
					if (response.response.message) {
						throw new Error(response.response.message);
					}
				}
			}
			// no idea what we have, lets fail it and send it back
			throw new Error(response);
		}
		throw new Error('Payload results are missing from the query');
	}

	/**
	 * @typedef {Object} ChaincodeInstantiateUpgradeRequest
	 * @property {Peer[]} targets - Optional. An array of endorsing
	 *           {@link Peer} objects as the targets of the request. When this
	 *           parameter is omitted the target list will include peers assigned
	 *           to this channel instance that are in the endorsing role.
	 * @property {string} chaincodeType - Optional. Type of chaincode. One of
	 *           'golang', 'car', 'java' or 'node'. Default is 'golang'. Note that 'java'
	 *           is not supported as of v1.0.
	 * @property {string} chaincodeId - Required. The name of the chaincode
	 * @property {string} chaincodeVersion - Required. Version string of the chaincode,
	 *           such as 'v1'
	 * @property {TransactionID} txId - Required. Object with the transaction id
	 *           and nonce
	 * @property {map} transientMap - Optional. <string, byte[]> map that can be
	 *           used by the chaincode during initialization, but not saved in the
	 *           ledger. Data such as cryptographic information for encryption can
	 *           be passed to the chaincode using this technique.
	 * @property {string} fcn - Optional. The function name to be returned when
	 *           calling <code>stub.GetFunctionAndParameters()</code> in the target
	 *           chaincode. Default is 'init'.
	 * @property {string[]} args - Optional. Array of string arguments to pass to
	 *           the function identified by the <code>fcn</code> value.
	 * @property {Object} endorsement-policy - Optional. EndorsementPolicy object
	 *           for this chaincode (see examples below). If not specified, a default
	 *           policy of "a signature by any member from any of the organizations
	 *           corresponding to the array of member service providers" is used.
	 *           <b>WARNING:</b> The default policy is NOT recommended for production,
	 *           because this allows an application to bypass the proposal endorsement
	 *           and send a manually constructed transaction, with arbitrary output
	 *           in the write set, to the orderer directly. An application's own
	 *           signature would allow the transaction to be successfully validated
	 *           and committed to the ledger.
	 * @example <caption>Endorsement policy: "Signed by any member from one of the organizations"</caption>
	 * {
	 *   identities: [
	 *     { role: { name: "member", mspId: "org1" }},
	 *     { role: { name: "member", mspId: "org2" }}
	 *   ],
	 *   policy: {
	 *     "1-of": [{ "signed-by": 0 }, { "signed-by": 1 }]
	 *   }
	 * }
	 * @example <caption>Endorsement policy: "Signed by admin of the ordererOrg and any member from one of the peer organizations"</caption>
	 * {
	 *   identities: [
	 *     { role: { name: "member", mspId: "peerOrg1" }},
	 *     { role: { name: "member", mspId: "peerOrg2" }},
	 *     { role: { name: "admin", mspId: "ordererOrg" }}
	 *   ],
	 *   policy: {
	 *     "2-of": [
	 *       { "signed-by": 2},
	 *       { "1-of": [{ "signed-by": 0 }, { "signed-by": 1 }]}
	 *     ]
	 *   }
	 * }
	 */

	/**
	 * Sends a chaincode instantiate proposal to one or more endorsing peers.
	 *
	 * A chaincode must be instantiated on a channel-by-channel basis before it can
	 * be used. The chaincode must first be installed on the endorsing peers where
	 * this chaincode is expected to run, by calling [client.installChaincode()]{@link Client#installChaincode}.
	 * <br><br>
	 * Instantiating a chaincode is a full transaction operation, meaning it must be
	 * first endorsed as a proposal, then the endorsements are sent to the orderer
	 * to be processed for ordering and validation. When the transaction finally gets
	 * committed to the channel's ledger on the peers, the chaincode is then considered
	 * activated and the peers are ready to take requests to process transactions.
	 *
	 * @param {ChaincodeInstantiateUpgradeRequest} request
	 * @param {Number} timeout - A number indicating milliseconds to wait on the
	 *                              response before rejecting the promise with a
	 *                              timeout error. This overrides the default timeout
	 *                              of the Peer instance and the global timeout in the config settings.
	 * @returns {Promise} A Promise for the {@link ProposalResponseObject}
	 */
	sendInstantiateProposal(request, timeout) {
		return this._sendChaincodeProposal(request, 'deploy', timeout);
	}

	/**
	 * Sends a chaincode upgrade proposal to one or more endorsing peers.
	 *
	 * Upgrading a chaincode involves steps similar to instantiating a chaincode.
	 * The new chaincode must first be installed on the endorsing peers where
	 * this chaincode is expected to run.
	 * <br><br>
	 * Similar to instantiating a chaincode, upgrading chaincodes is also a full transaction
	 * operation.
	 *
	 * @param {ChaincodeInstantiateUpgradeRequest} request
	 * @param {Number} timeout - A number indicating milliseconds to wait on the
	 *                              response before rejecting the promise with a
	 *                              timeout error. This overrides the default timeout
	 *                              of the Peer instance and the global timeout in the config settings.
	 * @returns {Promise} A Promise for the {@link ProposalResponseObject}
	 */
	sendUpgradeProposal(request, timeout) {
		return this._sendChaincodeProposal(request, 'upgrade', timeout);
	}

	/*
	 * Internal method to handle both chaincode calls
	 */
	async _sendChaincodeProposal(request, command, timeout) {
		let errorMsg = null;

		//validate the incoming request
		if (!errorMsg) errorMsg = client_utils.checkProposalRequest(request, true);
		if (!errorMsg) errorMsg = client_utils.checkInstallRequest(request);
		if (errorMsg) {
			logger.error('sendChainCodeProposal error ' + errorMsg);
			throw new Error(errorMsg);
		}
		const peers = this._getTargets(request.targets, Constants.NetworkConfig.ENDORSING_PEER_ROLE);

		// args is optional because some chaincode may not need any input parameters during initialization
		if (!request.args) {
			request.args = [];
		}

		// step 1: construct a ChaincodeSpec
		const args = [];
		args.push(Buffer.from(request.fcn ? request.fcn : 'init', 'utf8'));

		for (const arg of request.args)
			args.push(Buffer.from(arg, 'utf8'));

		const ccSpec = {
			type: client_utils.translateCCType(request.chaincodeType),
			chaincode_id: {
				name: request.chaincodeId,
				version: request.chaincodeVersion
			},
			input: {
				args: args
			}
		};

		// step 2: construct the ChaincodeDeploymentSpec
		const chaincodeDeploymentSpec = new _ccProto.ChaincodeDeploymentSpec();
		chaincodeDeploymentSpec.setChaincodeSpec(ccSpec);

		const signer = this._clientContext._getSigningIdentity(request.txId.isAdmin());
		/**
		 * lcccSpec_args:
		 * args[0] is the command
		 * args[1] is the channel name
		 * args[2] is the ChaincodeDeploymentSpec
		 *
		 * the following optional arguments here (they can each be nil and may or may not be present)
		 * args[3] is a marshaled SignaturePolicyEnvelope representing the endorsement policy
		 * args[4] is the name of escc
		 * args[5] is the name of vscc
		 * args[6] is a marshaled CollectionConfigPackage struct
		 */
		const lcccSpec_args = [
			Buffer.from(command),
			Buffer.from(this._name),
			chaincodeDeploymentSpec.toBuffer(),
			Buffer.from(''),
			Buffer.from(''),
			Buffer.from(''),
		];
		if (request['endorsement-policy']) {
			lcccSpec_args[3] = this._buildEndorsementPolicy(request['endorsement-policy']);
		}
		if (request['collections-config']) {
			const collectionConfigPackage = CollectionConfig.buildCollectionConfigPackage(request['collections-config']);
			lcccSpec_args[6] = collectionConfigPackage.toBuffer();
		}

		const lcccSpec = {
			// type: _ccProto.ChaincodeSpec.Type.GOLANG,
			type: client_utils.translateCCType(request.chaincodeType),
			chaincode_id: {name: Constants.LSCC},
			input: {args: lcccSpec_args}
		};

		const channelHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.ENDORSER_TRANSACTION,
			this._name,
			request.txId.getTransactionID(),
			null,
			Constants.LSCC,
			client_utils.buildCurrentTimestamp(),
			this._clientContext.getClientCertHash()
		);
		const header = client_utils.buildHeader(signer, channelHeader, request.txId.getNonce());
		const proposal = client_utils.buildProposal(lcccSpec, header, request.transientMap);
		const signed_proposal = client_utils.signProposal(signer, proposal);

		const responses = await client_utils.sendPeersProposal(peers, signed_proposal, timeout);
		return [responses, proposal];
	}

	/**
	 * @typedef {Object} ChaincodeInvokeRequest
	 * @property {Peer[]} targets - Optional. The peers that will receive this request,
	 *           when not provided the list of peers added to this channel object will
	 *           be used. When this channel has been initialized using the discovery
	 *           service the proposal will be sent to the peers on the list provided
	 *           discovery service if no targets are specified.
	 * @property {string} chaincodeId - Required. The id of the chaincode to process
	 *           the transaction proposal
	 * @property {TransactionID} txId - Required. TransactionID object with the
	 *           transaction id and nonce
	 * @property {map} transientMap - Optional. <string, byte[]> map that can be
	 *           used by the chaincode but not
	 *           saved in the ledger, such as cryptographic information for encryption
	 * @property {string} fcn - Optional. The function name to be returned when
	 *           calling <code>stub.GetFunctionAndParameters()</code>
	 *           in the target chaincode. Default is 'invoke'
	 * @property {string[]} args - An array of string arguments specific to the
	 *           chaincode's 'Invoke' method
	 * @property {string[]} ignore - Optional. An array of strings that represent
	 *           the names of peers that should be ignored by the endorsement.
	 *           This list only applies to endorsements using the discovery service.
	 * @property {string[]} preferred - Optional. An array of strings that represent
	 *           the names of peers that should be given priority by the endorsement.
	 *           This list only applies to endorsements using the discovery service.
	 */

	/**
	 * Sends a transaction proposal to one or more endorsing peers.
	 *
	 * After a chaincode gets [installed]{@link Client#installChaincode} and
	 * [instantiated]{@link Channel#instantiateChaincode}, it's ready to take endorsement
	 * proposals and participating in transaction processing. A chaincode transaction
	 * starts with a proposal that gets sent to the endorsing peers, which executes
	 * the target chaincode and decides whether the proposal should be endorsed (if it
	 * executes successfully) or not (if the chaincode returns an error).
	 *
	 * @param {ChaincodeInvokeRequest} request
	 * @param {Number} timeout - A number indicating milliseconds to wait on the
	 *        response before rejecting the promise with a timeout error. This
	 *        overrides the default timeout of the Peer instance and the global
	 *        timeout in the config settings.
	 * @returns {Promise} A Promise for the {@link ProposalResponseObject}
	 */
	async sendTransactionProposal(request, timeout) {
		const method = 'sendTransactionProposal';
		logger.debug('%s - start', method);

		let errorMsg = client_utils.checkProposalRequest(request, true);

		if (errorMsg) {
			// do nothing so we skip the rest of the checks
		} else if (!request.args) {
			// args is not optional because we need for transaction to execute
			errorMsg = 'Missing "args" in Transaction proposal request';
		}

		if (errorMsg) {
			logger.error('%s error %s', method, errorMsg);
			throw new Error(errorMsg);
		}


		if (this._endorsement_handler) {
			logger.debug('%s - running with endorsement handler');
			const proposal = Channel._buildSignedProposal(request, this._name, this._clientContext);

			const params = {
				request: request,
				signed_proposal: proposal.signed,
				timeout: timeout
			};

			const responses = await this._endorsement_handler.endorse(params);

			return [responses, proposal.source];
		} else {
			logger.debug('%s - running without endorsement handler');
			request.targets = this._getTargets(request.targets, Constants.NetworkConfig.ENDORSING_PEER_ROLE);

			return Channel.sendTransactionProposal(request, this._name, this._clientContext, timeout);
		}
	}

	/*
	 * Internal static method to allow transaction proposals to be called without
	 * creating a new channel
	 */
	static async sendTransactionProposal(request, channelId, client_context, timeout) {
		const method = 'sendTransactionProposal(static)';
		logger.debug('%s - start');

		let errorMsg = client_utils.checkProposalRequest(request, true);

		if (errorMsg) {
			// do nothing so we skip the rest of the checks
		} else if (!request.args) {
			// args is not optional because we need for transaction to execute
			errorMsg = 'Missing "args" in Transaction proposal request';
		} else if (!request.targets || request.targets.length < 1) {
			errorMsg = 'Missing peer objects in Transaction proposal';
		}

		if (errorMsg) {
			logger.error('%s error %s', method, errorMsg);
			throw new Error(errorMsg);
		}

		const proposal = Channel._buildSignedProposal(request, channelId, client_context);

		const responses = await client_utils.sendPeersProposal(request.targets, proposal.signed, timeout);
		return [responses, proposal.source];
	}

	static _buildSignedProposal(request, channelId, client_context) {
		const method = '_buildSignedProposal';
		logger.debug('%s - start', method);

		const args = [];
		args.push(Buffer.from(request.fcn ? request.fcn : 'invoke', 'utf8'));
		logger.debug('%s - adding function arg:%s', method, request.fcn ? request.fcn : 'invoke');

		for (let i = 0; i < request.args.length; i++) {
			logger.debug('%s - adding arg', method);
			args.push(Buffer.from(request.args[i], 'utf8'));
		}
		//special case to support the bytes argument of the query by hash
		if (request.argbytes) {
			logger.debug('%s - adding the argument :: argbytes', method);
			args.push(request.argbytes);
		}
		else {
			logger.debug('%s - not adding the argument :: argbytes', method);
		}

		const invokeSpec = {
			type: _ccProto.ChaincodeSpec.Type.GOLANG,
			chaincode_id: {name: request.chaincodeId},
			input: {args: args}
		};

		let signer = null;
		if (request.signer) {
			signer = request.signer;
		} else {
			signer = client_context._getSigningIdentity(request.txId.isAdmin());
		}

		const channelHeader = client_utils.buildChannelHeader(
			_commonProto.HeaderType.ENDORSER_TRANSACTION,
			channelId,
			request.txId.getTransactionID(),
			null,
			request.chaincodeId,
			client_utils.buildCurrentTimestamp(),
			client_context.getClientCertHash()
		);

		const header = client_utils.buildHeader(signer, channelHeader, request.txId.getNonce());
		const proposal = client_utils.buildProposal(invokeSpec, header, request.transientMap);
		const signed_proposal = client_utils.signProposal(signer, proposal);

		return {signed: signed_proposal, source: proposal};
	}

	/**
	 * @typedef {Object} TransactionRequest
	 * @property {array} proposalResponses - An array of or a single
	 *           {@link ProposalResponse} object containing the response from the
	 *           [endorsement]{@link Channel#sendTransactionProposal} call
	 * @property {Object} proposal - A Proposal object containing the original
	 *           request for endorsement(s)
	 * @property {Object} txID - Optional. - Must be the transaction ID object
	 *           used in the proposal endorsement. The transactionID will
	 *           only be used to determine if the signing of the request
	 *           should be done by the admin identity or the user assigned
	 *           to the client instance.
	 */

	/**
	 * Send the proposal responses that contain the endorsements of a transaction proposal
	 * to the orderer for further processing. This is the 2nd phase of the transaction
	 * lifecycle in the fabric. The orderer will globally order the transactions in the
	 * context of this channel and deliver the resulting blocks to the committing peers for
	 * validation against the chaincode's endorsement policy. When the committering peers
	 * successfully validate the transactions, it will mark the transaction as valid inside
	 * the block. After all transactions in a block have been validated, and marked either as
	 * valid or invalid (with a [reason code]{@link https://github.com/hyperledger/fabric/blob/v1.0.0/protos/peer/transaction.proto#L125}),
	 * the block will be appended (committed) to the channel's ledger on the peer.
	 * <br><br>
	 * The caller of this method must use the proposal responses returned from the endorser along
	 * with the original proposal that was sent to the endorser. Both of these objects are contained
	 * in the {@link ProposalResponseObject} returned by calls to any of the following methods:
	 * <li>[installChaincode()]{@link Client#installChaincode}
	 * <li>[sendInstantiateProposal()]{@link Channel#sendInstantiateProposal}
	 * <li>[sendUpgradeProposal()]{@link Channel#sendUpgradeProposal}
	 * <li>[sendTransactionProposal()]{@link Channel#sendTransactionProposal}
	 *
	 * @param {TransactionRequest} request - {@link TransactionRequest}
	 * @param {Number} timeout - A number indicating milliseconds to wait on the
	 *        response before rejecting the promise with a timeout error. This
	 *        overrides the default timeout of the Orderer instance and the global
	 *        timeout in the config settings.
	 * @returns {Promise} A Promise for a "BroadcastResponse" message returned by
	 *          the orderer that contains a single "status" field for a
	 *          standard [HTTP response code]{@link https://github.com/hyperledger/fabric/blob/v1.0.0/protos/common/common.proto#L27}.
	 *          This will be an acknowledgement from the orderer of a successfully
	 *          submitted transaction.
	 */
	async sendTransaction(request, timeout) {
		logger.debug('sendTransaction - start :: channel %s', this);
		let errorMsg = null;

		if (request) {
			// Verify that data is being passed in
			if (!request.proposalResponses) {
				errorMsg = 'Missing "proposalResponses" parameter in transaction request';
			}
			if (!request.proposal) {
				errorMsg = 'Missing "proposal" parameter in transaction request';
			}
		} else {
			errorMsg = 'Missing input request object on the transaction request';
		}

		if (errorMsg) {
			logger.error('sendTransaction error ' + errorMsg);
			throw new Error(errorMsg);
		}

		const proposalResponses = request.proposalResponses;
		const chaincodeProposal = request.proposal;

		const endorsements = [];
		let proposalResponse = proposalResponses;
		if (Array.isArray(proposalResponses)) {
			for (let i = 0; i < proposalResponses.length; i++) {
				// make sure only take the valid responses to set on the consolidated response object
				// to use in the transaction object
				if (proposalResponses[i].response && proposalResponses[i].response.status === 200) {
					proposalResponse = proposalResponses[i];
					endorsements.push(proposalResponse.endorsement);
				}
			}
		} else {
			if (proposalResponse && proposalResponse.response && proposalResponse.response.status === 200) {
				endorsements.push(proposalResponse.endorsement);
			}
		}

		if (endorsements.length < 1) {
			logger.error('sendTransaction - no valid endorsements found');
			throw new Error('no valid endorsements found');
		}

		let use_admin_signer = false;
		if (request.txId) {
			use_admin_signer = request.txId.isAdmin();
		}

		const header = _commonProto.Header.decode(chaincodeProposal.getHeader());

		const chaincodeEndorsedAction = new _transProto.ChaincodeEndorsedAction();
		chaincodeEndorsedAction.setProposalResponsePayload(proposalResponse.payload);
		chaincodeEndorsedAction.setEndorsements(endorsements);

		const chaincodeActionPayload = new _transProto.ChaincodeActionPayload();
		chaincodeActionPayload.setAction(chaincodeEndorsedAction);

		// the TransientMap field inside the original proposal payload is only meant for the
		// endorsers to use from inside the chaincode. This must be taken out before sending
		// to the orderer, otherwise the transaction will be rejected by the validators when
		// it compares the proposal hash calculated by the endorsers and returned in the
		// proposal response, which was calculated without the TransientMap
		const originalChaincodeProposalPayload = _proposalProto.ChaincodeProposalPayload.decode(chaincodeProposal.payload);
		const chaincodeProposalPayloadNoTrans = new _proposalProto.ChaincodeProposalPayload();
		chaincodeProposalPayloadNoTrans.setInput(originalChaincodeProposalPayload.input); // only set the input field, skipping the TransientMap
		chaincodeActionPayload.setChaincodeProposalPayload(chaincodeProposalPayloadNoTrans.toBuffer());

		const transactionAction = new _transProto.TransactionAction();
		transactionAction.setHeader(header.getSignatureHeader());
		transactionAction.setPayload(chaincodeActionPayload.toBuffer());

		const actions = [];
		actions.push(transactionAction);

		const transaction = new _transProto.Transaction();
		transaction.setActions(actions);


		const payload = new _commonProto.Payload();
		payload.setHeader(header);
		payload.setData(transaction.toBuffer());

		const payload_bytes = payload.toBuffer();

		const signer = this._clientContext._getSigningIdentity(use_admin_signer);
		const sig = signer.sign(payload_bytes);
		const signature = Buffer.from(sig);

		// building manually or will get protobuf errors on send
		const envelope = {
			signature: signature,
			payload: payload_bytes
		};

		if (this._commit_handler) {
			const params = {
				signed_envelope: envelope,
				request: request,
				timeout: timeout
			};
			return this._commit_handler.commit(params);

		} else {
			// verify that we have an orderer configured
			const orderer = this._clientContext.getTargetOrderer(request.orderer, this.getOrderers(), this._name);
			return orderer.sendBroadcast(envelope);
		}
	}

	/**
	 * @typedef {Object} ChaincodeQueryRequest
	 * @property {Peer[]} targets - Optional. The peers that will receive this request,
	 *                                when not provided the list of peers added to this channel object will be used.
	 * @property {string} chaincodeId - Required. The id of the chaincode to process the transaction proposal
	 * @property {map} transientMap - Optional. <string, byte[]> map that can be used by the chaincode but not
	 *                                  saved in the ledger, such as cryptographic information for encryption
	 * @property {string} fcn - Optional. The function name to be returned when calling <code>stub.GetFunctionAndParameters()</code>
	 *                          in the target chaincode. Default is 'invoke'
	 * @property {string[]} args - An array of string arguments specific to the chaincode's 'Invoke' method
	 */

	/**
	 * Sends a proposal to one or more endorsing peers that will be handled by the chaincode.
	 * In fabric v1.0, there is no difference in how the endorsing peers process a request
	 * to invoke a chaincode for transaction vs. to invoke a chaincode for query. All requests
	 * will be presented to the target chaincode's 'Invoke' method which must be implemented to
	 * understand from the arguments that this is a query request. The chaincode must also return
	 * results in the byte array format and the caller will have to be able to decode
	 * these results.
	 *
	 * @param {ChaincodeQueryRequest} request
	 * @param {boolean} useAdmin - Optional. Indicates that the admin credentials should be used in making
	 *                  this call
	 * @returns {Promise} A Promise for an array of byte array results returned from the chaincode
	 *                    on all Endorsing Peers
	 * @example
	 * <caption>Get the list of query results returned by the chaincode</caption>
	 * channel.queryByChaincode(request)
	 * .then((response_payloads) => {
	 *		for(let i = 0; i < response_payloads.length; i++) {
	 *			console.log(util.format('Query result from peer [%s]: %s', i, response_payloads[i].toString('utf8')));
	 *		}
	 *	});
	 */
	async queryByChaincode(request, useAdmin) {
		logger.debug('queryByChaincode - start');
		if (!request) {
			throw new Error('Missing request object for this queryByChaincode call.');
		}

		const targets = this._getTargets(request.targets, Constants.NetworkConfig.CHAINCODE_QUERY_ROLE);
		const signer = this._clientContext._getSigningIdentity(useAdmin);
		const txId = new TransactionID(signer, useAdmin);

		// make a new request object so we can add in the txId and not change the user's
		const query_request = {
			targets: targets,
			chaincodeId: request.chaincodeId,
			fcn: request.fcn,
			args: request.args,
			transientMap: request.transientMap,
			txId: txId,
			signer: signer
		};

		const results = await Channel.sendTransactionProposal(query_request, this._name, this._clientContext, null);
		const responses = results[0];
		logger.debug('queryByChaincode - results received');
		if (responses && Array.isArray(responses)) {
			const results = [];
			for (let i = 0; i < responses.length; i++) {
				const response = responses[i];
				if (response instanceof Error) {
					results.push(response);
				}
				else if (response.response && response.response.payload) {
					if (response.response.status === 200) {
						results.push(response.response.payload);
					} else {
						if (response.response.message) {
							results.push(new Error(response.response.message));
						} else {
							results.push(new Error(response));
						}
					}
				}
				else {
					logger.error('queryByChaincode - unknown or missing results in query ::' + results);
					results.push(new Error(response));
				}
			}
			return results;
		}
		throw new Error('Payload results are missing from the chaincode query');
	}

	/**
	 * Utility method to verify a single proposal response. It checks the
	 * following aspects:
	 * <li>The endorser's identity belongs to a legitimate MSP of the channel
	 *     and can be successfully deserialized
	 * <li>The endorsement signature can be successfully verified with the
	 *     endorser's identity certificate
	 * <br><br>
	 * This method requires that the initialize method of this channel object
	 * has been called to load this channel's MSPs. The MSPs will have the
	 * trusted root certificates for this channel.
	 *
	 * @param {ProposalResponse} proposal_response - The endorsement response from the peer,
	 *                             includes the endorser certificate and signature over the
	 *                             proposal + endorsement result + endorser certificate.
	 * @returns {boolean} A boolean value of true when both the identity and
	 *                    the signature are valid, false otherwise.
	 */
	verifyProposalResponse(proposal_response) {
		logger.debug('verifyProposalResponse - start');
		if (!proposal_response) {
			throw new Error('Missing proposal response');
		}
		if (!proposal_response.endorsement) {
			throw new Error('Parameter must be a ProposalResponse Object');
		}

		const endorsement = proposal_response.endorsement;
		let identity;

		const sid = _identityProto.SerializedIdentity.decode(endorsement.endorser);
		const mspid = sid.getMspid();
		logger.debug('getMSPbyIdentity - found mspid %s', mspid);
		const msp = this._msp_manager.getMSP(mspid);

		if (!msp) {
			throw new Error(util.format('Failed to locate an MSP instance matching the endorser identity\'s organization %s', mspid));
		}
		logger.debug('verifyProposalResponse - found endorser\'s MSP');

		try {
			identity = msp.deserializeIdentity(endorsement.endorser, false);
			if (!identity) {
				throw new Error('Unable to find the endorser identity');
			}
		}
		catch (error) {
			logger.error('verifyProposalResponse - getting endorser identity failed with: ', error);
			return false;
		}

		try {
			// see if the identity is trusted
			if (!identity.isValid()) {
				logger.error('Endorser identity is not valid');
				return false;
			}
			logger.debug('verifyProposalResponse - have a valid identity');

			// check the signature against the endorser and payload hash
			const digest = Buffer.concat([proposal_response.payload, endorsement.endorser]);
			if (!identity.verify(digest, endorsement.signature)) {
				logger.error('Proposal signature is not valid');
				return false;
			}
		}
		catch (error) {
			logger.error('verifyProposalResponse - verify failed with: ', error);
			return false;
		}

		logger.debug('verifyProposalResponse - This endorsement has both a valid identity and valid signature');
		return true;
	}

	/**
	 * Utility method to examine a set of proposals to check they contain
	 * the same endorsement result write sets.
	 * This will validate that the endorsing peers all agree on the result
	 * of the chaincode execution.
	 *
	 * @param {ProposalResponse[]} The proposal responses from all endorsing peers
	 * @returns {boolean} True when all proposals compare equally, false otherwise.
	 */
	compareProposalResponseResults(proposal_responses) {
		logger.debug('compareProposalResponseResults - start');
		if (!proposal_responses) {
			throw new Error('Missing proposal responses');
		}
		if (!Array.isArray(proposal_responses)) {
			throw new Error('Parameter must be an array of ProposalRespone Objects');
		}

		if (proposal_responses.length == 0) {
			throw new Error('Parameter proposal responses does not contain a PorposalResponse');
		}
		const first_one = _getProposalResponseResults(proposal_responses[0]);
		for (let i = 1; i < proposal_responses.length; i++) {
			const next_one = _getProposalResponseResults(proposal_responses[i]);
			if (next_one.equals(first_one)) {
				logger.debug('compareProposalResponseResults - read/writes result sets match index=%s', i);
			}
			else {
				logger.error('compareProposalResponseResults - read/writes result sets do not match index=%s', i);
				return false;
			}
		}

		return true;
	}

	/*
	 *  utility method to decide on the target for queries that only need ledger access
	 */
	_getTargetForQuery(target) {
		if (Array.isArray(target)) {
			throw new Error('"target" parameter is an array, but should be a singular peer object' +
				' ' + 'or peer name according to the network configuration loaded by the client instance');
		}
		let targets = this._getTargets(target, Constants.NetworkConfig.LEDGER_QUERY_ROLE, true);
		// only want to query one peer
		if (targets && targets.length > 0) {
			targets = [targets[0]];
		}

		return targets;
	}

	/*
	 *  utility method to decide on the target for queries that only need ledger access
	 */
	_getFirstAvailableTarget(target) {
		let targets = this._getTargets(target, Constants.NetworkConfig.ALL_ROLES, true);
		// only want to query one peer
		if (targets && targets.length > 0) {
			targets = targets[0];
		}

		return targets;
	}

	/*
	 *  utility method to decide on the target for discovery
	 */
	_getTargetForDiscovery(target) {
		const targets = this._getTargets(target, Constants.NetworkConfig.DISCOVERY_ROLE, true);
		// only want one peer
		return targets[0];
	}

	/*
	 * utility method to decide on the targets for requests
	 */
	_getTargets(request_targets, role, isTarget) {
		const targets = [];
		if (request_targets) {
			let targetsTemp = request_targets;
			if (!Array.isArray(request_targets)) {
				targetsTemp = [request_targets];
			}
			for (const target_peer of targetsTemp) {
				if (typeof target_peer === 'string') {
					const channel_peer = this._channel_peers.get(target_peer);
					if (channel_peer) {
						targets.push(channel_peer.getPeer());
					} else {
						throw new Error(util.format(PEER_NOT_ASSIGNED_MSG, target_peer));
					}
				} else if (target_peer && target_peer.constructor && target_peer.constructor.name === 'Peer') {
					targets.push(target_peer);
				} else if (target_peer && target_peer.constructor && target_peer.constructor.name === 'ChannelPeer') {
					targets.push(target_peer.getPeer());
				} else {
					throw new Error('Target peer is not a valid peer object instance');
				}
			}
		} else {
			this._channel_peers.forEach((channel_peer) => {
				if (channel_peer.isInRole(role)) {
					targets.push(channel_peer.getPeer());
				}
			});
		}

		if (targets.length == 0) {
			let target_msg = 'targets';
			if (isTarget) target_msg = 'target';
			if (role === Constants.NetworkConfig.EVENT_SOURCE_ROLE) target_msg = 'peer';
			throw new Error(util.format('"%s" parameter not specified and no peers'
				+ ' ' + 'are set on this Channel instance'
				+ ' ' + 'or specfied for this channel in the network ', target_msg));
		}

		return targets;
	}

	/*
	 * utility method to decide on the orderer
	 */
	_getOrderer(request_orderer) {
		let orderer = null;
		if (request_orderer) {
			if (typeof request_orderer === 'string') {
				orderer = this._orderers.get(request_orderer);
				if (!orderer) {
					throw new Error(util.format('Orderer %s not assigned to the channel', request_orderer));
				}
			} else if (request_orderer && request_orderer.constructor && request_orderer.constructor.name === 'Orderer') {
				orderer = request_orderer;
			} else {
				throw new Error('Orderer is not a valid orderer object instance');
			}
		} else {
			const orderers = this.getOrderers();
			orderer = orderers[0];
			if (!orderer) {
				throw new Error('No Orderers assigned to this channel');
			}
		}

		return orderer;
	}

	// internal utility method to build chaincode policy
	_buildEndorsementPolicy(policy) {
		return Policy.buildPolicy(this.getMSPManager().getMSPs(), policy);
	}

	/**
	 * return a printable representation of this channel object
	 */
	toString() {
		const orderers = [];
		for (const orderer of this.getOrderers()) {
			orderers.push(orderer.toString());
		}

		const peers = [];
		for (const peer of this.getPeers()) {
			peers.push(peer.toString());
		}

		const state = {
			name: this._name,
			orderers: orderers.length > 0 ? orderers : 'N/A',
			peers: peers.length > 0 ? peers : 'N/A'
		};

		return JSON.stringify(state).toString();
	}

};

//internal utility method to decode and get the write set
//from a proposal response
function _getProposalResponseResults(proposal_response) {
	if (!proposal_response.payload) {
		throw new Error('Parameter must be a ProposalResponse Object');
	}
	const payload = _responseProto.ProposalResponsePayload.decode(proposal_response.payload);
	const extension = _proposalProto.ChaincodeAction.decode(payload.extension);
	// TODO should we check the status of this action
	logger.debug('_getWriteSet - chaincode action status:%s message:%s', extension.response.status, extension.response.message);
	// return a buffer object which has an equals method
	return extension.results.toBuffer();
}

/**
 * utility method to load in a config group
 * @param {Object} config_items - holder of values found in the configuration
 * @param {Object} versions
 * @param {Object} group - used for recursive calls
 * @param {string} name - used to help with the recursive calls
 * @param {string} org - Organizational name
 * @param {bool} top - to handle the  differences in the structure of groups
 * @see /protos/common/configtx.proto
 */
function loadConfigGroup(config_items, versions, group, name, org, top) {
	logger.debug('loadConfigGroup - %s - > group:%s', name, org);
	if (!group) {
		logger.debug('loadConfigGroup - %s - no group', name);
		logger.debug('loadConfigGroup - %s - < group', name);
		return;
	}

	const isOrderer = (name.indexOf('base.Orderer') > -1);
	logger.debug('loadConfigGroup - %s   - version %s', name, group.version);
	logger.debug('loadConfigGroup - %s   - mod policy %s', name, group.mod_policy);

	let groups = null;
	if (top) {
		groups = group.groups;
		versions.version = group.version;
	}
	else {
		groups = group.value.groups;
		versions.version = group.value.version;
	}
	logger.debug('loadConfigGroup - %s - >> groups', name);

	if (groups) {
		const keys = Object.keys(groups.map);
		versions.groups = {};
		if (keys.length === 0) {
			logger.debug('loadConfigGroup - %s   - no groups', name);
		}
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			logger.debug('loadConfigGroup - %s   - found config group ==> %s', name, key);
			versions.groups[key] = {};
			// The Application group is where config settings are that we want to find
			loadConfigGroup(config_items, versions.groups[key], groups.map[key], name + '.' + key, key, false);
		}
	}
	else {
		logger.debug('loadConfigGroup - %s   - no groups', name);
	}
	logger.debug('loadConfigGroup - %s - << groups', name);

	logger.debug('loadConfigGroup - %s - >> values', name);
	let values = null;
	if (top) {
		values = group.values;
	}
	else {
		values = group.value.values;
	}
	if (values) {
		versions.values = {};
		const keys = Object.keys(values.map);
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			versions.values[key] = {};
			const config_value = values.map[key];
			loadConfigValue(config_items, versions.values[key], config_value, name, org, isOrderer);
		}
	}
	else {
		logger.debug('loadConfigGroup - %s   - no values', name);
	}
	logger.debug('loadConfigGroup - %s - << values', name);

	logger.debug('loadConfigGroup - %s - >> policies', name);
	let policies = null;
	if (top) {
		policies = group.policies;
	}
	else {
		policies = group.value.policies;
	}
	if (policies) {
		versions.policies = {};
		const keys = Object.keys(policies.map);
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			versions.policies[key] = {};
			const config_policy = policies.map[key];
			loadConfigPolicy(config_items, versions.policies[key], config_policy, name, org);
		}
	}
	else {
		logger.debug('loadConfigGroup - %s   - no policies', name);
	}
	logger.debug('loadConfigGroup - %s - << policies', name);

	logger.debug('loadConfigGroup - %s - < group', name);
}

/**
 * utility method to load in a config value
 * @see /protos/common/configtx.proto
 * @see /protos/msp/mspconfig.proto
 * @see /protos/orderer/configuration.proto
 * @see /protos/peer/configuration.proto
 */
function loadConfigValue(config_items, versions, config_value, group_name, org, isOrderer) {
	logger.debug('loadConfigValue - %s -  value name: %s', group_name, config_value.key);
	logger.debug('loadConfigValue - %s    - version: %s', group_name, config_value.value.version);
	logger.debug('loadConfigValue - %s    - mod_policy: %s', group_name, config_value.value.mod_policy);

	versions.version = config_value.value.version;
	try {
		switch (config_value.key) {
		case 'AnchorPeers': {
			const anchor_peers = _peerConfigurationProto.AnchorPeers.decode(config_value.value.value);
			logger.debug('loadConfigValue - %s    - AnchorPeers :: %s', group_name, anchor_peers);
			if (anchor_peers && anchor_peers.anchor_peers) for (const i in anchor_peers.anchor_peers) {
				const anchor_peer = {
					host: anchor_peers.anchor_peers[i].host,
					port: anchor_peers.anchor_peers[i].port,
					org: org
				};
				config_items['anchor-peers'].push(anchor_peer);
				logger.debug('loadConfigValue - %s    - AnchorPeer :: %s:%s:%s', group_name, anchor_peer.host, anchor_peer.port, anchor_peer.org);
			}
			break;
		}
		case 'MSP': {
			const msp_value = _mspConfigProto.MSPConfig.decode(config_value.value.value);
			logger.debug('loadConfigValue - %s    - MSP found', group_name);
			if (!isOrderer) config_items.msps.push(msp_value);
			break;
		}
		case 'ConsensusType': {
			const consensus_type = _ordererConfigurationProto.ConsensusType.decode(config_value.value.value);
			config_items.settings['ConsensusType'] = consensus_type;
			logger.debug('loadConfigValue - %s    - Consensus type value :: %s', group_name, consensus_type.type);
			break;
		}
		case 'BatchSize': {
			const batch_size = _ordererConfigurationProto.BatchSize.decode(config_value.value.value);
			config_items.settings['BatchSize'] = batch_size;
			logger.debug('loadConfigValue - %s    - BatchSize  max_message_count :: %s', group_name, batch_size.maxMessageCount);
			logger.debug('loadConfigValue - %s    - BatchSize  absolute_max_bytes :: %s', group_name, batch_size.absoluteMaxBytes);
			logger.debug('loadConfigValue - %s    - BatchSize  preferred_max_bytes :: %s', group_name, batch_size.preferredMaxBytes);
			break;
		}
		case 'BatchTimeout': {
			const batch_timeout = _ordererConfigurationProto.BatchTimeout.decode(config_value.value.value);
			config_items.settings['BatchTimeout'] = batch_timeout;
			logger.debug('loadConfigValue - %s    - BatchTimeout timeout value :: %s', group_name, batch_timeout.timeout);
			break;
		}
		case 'ChannelRestrictions': {
			const channel_restrictions = _ordererConfigurationProto.ChannelRestrictions.decode(config_value.value.value);
			config_items.settings['ChannelRestrictions'] = channel_restrictions;
			logger.debug('loadConfigValue - %s    - ChannelRestrictions max_count value :: %s', group_name, channel_restrictions.max_count);
			break;
		}
		case 'ChannelCreationPolicy': {
			const creation_policy = _policiesProto.Policy.decode(config_value.value.value);
			loadPolicy(config_items, versions, config_value.key, creation_policy, group_name, org);
			break;
		}
		case 'HashingAlgorithm': {
			const hashing_algorithm_name = _commonConfigurationProto.HashingAlgorithm.decode(config_value.value.value);
			config_items.settings['HashingAlgorithm'] = hashing_algorithm_name;
			logger.debug('loadConfigValue - %s    - HashingAlgorithm name value :: %s', group_name, hashing_algorithm_name.name);
			break;
		}
		case 'Consortium': {
			const consortium_algorithm_name = _commonConfigurationProto.Consortium.decode(config_value.value.value);
			config_items.settings['Consortium'] = consortium_algorithm_name;
			logger.debug('loadConfigValue - %s    - Consortium name value :: %s', group_name, consortium_algorithm_name.name);
			break;
		}
		case 'BlockDataHashingStructure': {
			const blockdata_hashing_structure = _commonConfigurationProto.BlockDataHashingStructure.decode(config_value.value.value);
			config_items.settings['BlockDataHashingStructure'] = blockdata_hashing_structure;
			logger.debug('loadConfigValue - %s    - BlockDataHashingStructure width value :: %s', group_name, blockdata_hashing_structure.width);
			break;
		}
		case 'OrdererAddresses': {
			const orderer_addresses = _commonConfigurationProto.OrdererAddresses.decode(config_value.value.value);
			logger.debug('loadConfigValue - %s    - OrdererAddresses addresses value :: %s', group_name, orderer_addresses.addresses);
			if (orderer_addresses && orderer_addresses.addresses) {
				for (const address of orderer_addresses.addresses) {
					config_items.orderers.push(address);
				}
			}
			break;
		}
		case 'KafkaBrokers': {
			const kafka_brokers = _ordererConfigurationProto.KafkaBrokers.decode(config_value.value.value);
			logger.debug('loadConfigValue - %s    - KafkaBrokers addresses value :: %s', group_name, kafka_brokers.brokers);
			if (kafka_brokers && kafka_brokers.brokers) {
				for (const broker of kafka_brokers.brokers) {
					config_items['kafka-brokers'].push(broker);
				}
			}
			break;
		}
		default:
			logger.debug('loadConfigValue - %s    - value: %s', group_name, config_value.value.value);
		}
	}
	catch (err) {
		logger.debug('loadConfigValue - %s - name: %s - *** unable to parse with error :: %s', group_name, config_value.key, err);
	}
}

/**
 * @typedef {Object} ChannelPeerRoles
 * @property {boolean} endorsingPeer - Optional. This peer may be sent transaction
 *           proposals for endorsements. The peer must have the chaincode installed.
 *           The app can also use this property to decide which peers to send the
 *           chaincode install request.
 *           Default: true
 *
 * @property {boolean} chaincodeQuery - Optional. This peer may be sent transaction
 *           proposals meant only as a query. The peer must have the chaincode
 *           installed. The app can also use this property to decide which peers
 *           to send the chaincode install request.
 *           Default: true
 *
 * @property {boolean} ledgerQuery - Optional. This peer may be sent query proposals
 *           that do not require chaincodes, like queryBlock(), queryTransaction(), etc.
 *           Default: true
 *
 * @property {boolean} eventSource - Optional. This peer may be the target of a
 *           event listener registration? All peers can produce events, but the
 *           appliatiion typically only needs to connect to one.
 *           Default: true
 */

/**
 * The ChannelPeer class represents a peer in the target blockchain network on this channel.
 *
 * @class
 */
const ChannelPeer = class {
	/**
	 * Construct a ChannelPeer object with the given Peer and opts.
	 * A channel peer object holds channel based references:
	 *   MSP ID of the Organization this peer belongs.
	 *   {@link Channel} object used to know the channel this peer is interacting.
	 *   {@link Peer} object used for interacting with the Hyperledger fabric network.
	 *   {@link ChannelEventHub} object used for listening to block changes on the channel.
	 *   List of {@link ChannelPeerRoles} to indicate the roles this peer performs on the channel.
	 *
	 * The roles this Peer performs on this channel are indicated with is object.
	 *
	 * @param {string} mspid - The mspid of the organization this peer belongs.
	 * @param {Channel} channel - The Channel instance.
	 * @param {Peer} peer - The Peer instance.
	 * @param {ChannelPeerRoles} roles - The roles for this peer.
	 */
	constructor(mspid, channel, peer, roles) {
		this._mspid = mspid;
		if (channel && channel.constructor && channel.constructor.name === 'Channel') {
			if (peer && peer.constructor && peer.constructor.name === 'Peer') {
				this._channel = channel;
				this._name = peer.getName();
				this._chaincodes = new Map();
				this._peer = peer;
				this._roles = {};
				logger.debug('ChannelPeer.const - url: %s', peer.getUrl());
				if (roles && typeof roles === 'object') {
					this._roles = Object.assign(roles, this._roles);
				}
			} else {
				throw new Error('Missing Peer parameter');
			}
		} else {
			throw new Error('Missing Channel parameter');
		}
	}

	/**
	 * Close the associated peer service connections.
	 * <br>see {@link Peer#close}
	 * <br>see {@link ChannelEventHub#close}
	 */
	close() {
		this._peer.close();
		if (this._channel_event_hub) {
			this._channel_event_hub.close();
		}
	}


	/**
	 * Get the MSP ID.
	 *
	 * @returns {string} The mspId.
	 */
	getMspid() {
		return this._mspid;
	}

	/**
	 * Get the name. This is a client-side only identifier for this
	 * object.
	 *
	 * @returns {string} The name of the object
	 */
	getName() {
		return this._name;
	}

	/**
	 * Get the URL of this object.
	 *
	 * @returns {string} Get the URL associated with the peer object.
	 */
	getUrl() {
		return this._peer.getUrl();
	}

	/**
	 * Set a role for this peer.
	 *
	 * @param {string} role - The name of the role
	 * @param {boolean} isIn - The boolean value of does this peer have this role
	 */
	setRole(role, isIn) {
		this._roles[role] = isIn;
	}

	/**
	 * Checks if this peer is in the specified role.
	 * The default is true when the incoming role is not defined.
	 * The default will be true when this peer does not have the role defined.
	 *
	 * @returns {boolean} If this peer has this role.
	 */
	isInRole(role) {
		if (!role) {
			throw new Error('Missing "role" parameter');
		} else if (typeof this._roles[role] === 'undefined') {
			return true;
		} else {
			return this._roles[role];
		}
	}

	/**
	 * Checks if this peer is in the specified organization.
	 * The default is true when the incoming organization name is not defined.
	 * The default will be true when this peer does not have the organization name defined.
	 *
	 * @param {string} mspid - The mspid of the organnization
	 * @returns {boolean} If this peer belongs to the organization.
	 */
	isInOrg(mspid) {
		if (!mspid || !this._mspid) {
			return true;
		} else {
			return mspid === this._mspid;
		}
	}

	/**
	 * Get the channel event hub for this channel peer. The ChannelEventHub instance will
	 * be assigned when using the {@link Channel} newChannelEventHub() method. When using
	 * a common connection profile, the ChannelEventHub will be automatically assigned
	 * on the Channel Peers as they are created and added to the channel.
	 *
	 * @return {ChannelEventHub} - The ChannelEventHub instance associated with this {@link Peer} instance.
	 */
	getChannelEventHub() {
		if (!this._channel_event_hub) {
			this._channel_event_hub = new ChannelEventHub(this._channel, this._peer);
		}

		return this._channel_event_hub;
	}

	/**
	 * Get the Peer instance this ChannelPeer represents on the channel.
	 *
	 * @returns {Peer} The associated Peer instance.
	 */
	getPeer() {
		return this._peer;
	}

	/**
	 * Wrapper method for the associated peer so this object may be used as a {@link Peer}
	 * {@link Peer#sendProposal}
	 */
	sendProposal(proposal, timeout) {
		return this._peer.sendProposal(proposal, timeout);
	}

	/**
	 * Wrapper method for the associated peer so this object may be used as a {@link Peer}
	 * {@link Peer#sendDiscovery}
	 */
	sendDiscovery(request, timeout) {
		return this._peer.sendDiscovery(request, timeout);
	}

	toString() {
		return this._peer.toString();
	}
}; //endof ChannelPeer

/*
 * utility method to load in a config policy
 * @see /protos/common/configtx.proto
 */
function loadConfigPolicy(config_items, versions, config_policy, group_name, org) {
	logger.debug('loadConfigPolicy - %s - policy name: %s', group_name, config_policy.key);
	logger.debug('loadConfigPolicy - %s - version: %s', group_name, config_policy.value.version);
	logger.debug('loadConfigPolicy - %s - mod_policy: %s', group_name, config_policy.value.mod_policy);

	versions.version = config_policy.value.version;
	loadPolicy(config_items, versions, config_policy.key, config_policy.value.policy, group_name, org);
}

function loadPolicy(config_items, versions, key, policy, group_name) {
	try {
		if (policy.type === _policiesProto.Policy.PolicyType.SIGNATURE) {
			const signature_policy = _policiesProto.SignaturePolicyEnvelope.decode(policy.policy);
			logger.debug('loadPolicy - %s - policy SIGNATURE :: %s %s', group_name, signature_policy.encodeJSON(), decodeSignaturePolicy(signature_policy.getIdentities()));
		} else if (policy.type === _policiesProto.Policy.PolicyType.IMPLICIT_META) {
			const implicit_policy = _policiesProto.ImplicitMetaPolicy.decode(policy.value);
			const rule = ImplicitMetaPolicy_Rule[implicit_policy.getRule()];
			logger.debug('loadPolicy - %s - policy IMPLICIT_META :: %s %s', group_name, rule, implicit_policy.getSubPolicy());
		} else {
			logger.error('loadPolicy - Unknown policy type :: %s', policy.type);
			throw new Error('Unknown Policy type ::' + policy.type);
		}
	}
	catch (err) {
		logger.debug('loadPolicy - %s - name: %s - unable to parse policy %s', group_name, key, err);
	}
}

function decodeSignaturePolicy(identities) {
	const results = [];
	for (const i in identities) {
		const identity = identities[i];
		switch (identity.getPrincipalClassification()) {
		case _mspPrincipalProto.MSPPrincipal.Classification.ROLE:
			results.push(_mspPrincipalProto.MSPRole.decode(identity.getPrincipal()).encodeJSON());
		}
	}
	return results;
}

module.exports = Channel;
