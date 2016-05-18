/**
 * Cluster Server
 */
'use strict';

const _ = require('lodash');
const uuid = require('node-uuid');
const system_store = require('./system_store').get_instance();
const server_rpc = require('../server_rpc');
const MongoCtrl = require('../utils/mongo_ctrl');
const cutil = require('../utils/clustering_utils');
const P = require('../../util/promise');
const os_utils = require('../../util/os_util');
const dbg = require('../../util/debug_module')(__filename);
const config = require('../../../config.js');

function _init() {
    var self = this;
    if (os_utils.is_supervised_env()) {
        return os_utils.read_server_secret()
            .then((sec) => {
                self._secret = sec;
                return P.when(MongoCtrl.init());
            });
    }
}

//
//API
//

//Return new cluster info, if doesn't exists in db
function new_cluster_info() {
    if (system_store.get_local_cluster_info()) {
        return;
    }

    var cluster = {
        owner_secret: system_store.get_server_secret(),
        cluster_id: uuid().substring(0, 8),
        shards: [{
            shardname: 'shard1',
            servers: [{
                address: os_utils.get_local_ipv4_ips()[0] //TODO:: on multiple nics support, fix this
            }],
        }],
        config_servers: [],
    };

    return cluster;
}

//Initiate process of adding a server to the cluster
function add_member_to_cluster(req) {
    if (!os_utils.is_supervised_env()) {
        console.warn('Environment is not a supervised one, currently not allowing clustering operations');
        throw new Error('Environment is not a supervised one, currently not allowing clustering operations');
    }

    dbg.log0('Recieved add member to cluster req', req.rpc_params, 'current topology', cutil.get_topology());
    var id = cutil.get_topology().cluster_id;

    return P.fcall(function() {
            if (req.rpc_params.role === 'SHARD') {
                let myip = os_utils.get_local_ipv4_ips()[0];
                //If adding shard, and current server does not have config on it, add
                //This is the case on the addition of the first shard
                if (_.findIndex(cutil.get_topology().config_servers, function(srv) {
                        return srv.address === myip;
                    }) === -1) {
                    dbg.log0('Current server is the first on cluster and still has single mongo running, updating');
                    return _add_new_shard_on_server('shard1', myip, true); ///3rd param *first_shard*/
                }
            } else {
                return P.resolve();
            }
        })
        .then(function() {
            dbg.log0('Sending join_to_cluster to', req.rpc_params.ip);
            //Send the a join_to_cluster command to the new joining server
            return server_rpc.client.cluster_server.join_to_cluster({
                ip: req.rpc_params.ip,
                topology: cutil.get_topology(),
                cluster_id: id,
                secret: req.rpc_params.secret,
                role: req.rpc_params.role,
                shard: req.rpc_params.shard,
            }, {
                address: 'ws://' + req.rpc_params.ip + ':8080',
                timeout: 60000 //60s
            });
        })
        .fail(function(err) {
            console.error('Failed adding members to cluster', req.rpc_params, 'with', err);
            throw new Error('Failed adding members to cluster');
        })
        .then(function() {
            dbg.log0('Added member', req.rpc_params.ip, 'to cluster. New topology', cutil.get_topology());
            return;
        });
}

function join_to_cluster(req) {
    dbg.log0('Got join_to_cluster request', req.rpc_params);
    //Verify secrets match
    if (req.rpc_params.secret !== _get_secret()) {
        console.error('Secrets do not match!');
        throw new Error('Secrets do not match!');
    }

    //Verify we are not already joined to a cluster
    //TODO:: think how do we want to handle it, if at all
    if (cutil.get_topology().shards.length !== 1 ||
        cutil.get_topology().shards[0].servers.length !== 1) {
        console.error('Server already joined to a cluster');
        throw new Error('Server joined to a cluster');
    }

    //TODO:: need to think regarding role switch: ReplicaSet chain vs. Shard (or switching between
    //different ReplicaSet Chains)
    //Easy path -> don't support it, make admin detach and re-attach as new role,
    //though this creates more hassle for the admin and overall lengthier process

    dbg.log0('Replacing current topology', cutil.get_topology(), 'with', req.rpc_params.topology);
    cutil.update_cluster_info(req.rpc_params.topology);
    return P.fcall(function() {
            if (req.rpc_params.role === 'SHARD') {
                //Server is joining as a new shard, update the shard topology
                cutil.update_cluster_info(
                    cutil.get_topology().shards.push({
                        name: req.rpc_params.shard,
                        servers: [{
                            address: req.rpc_params.ip
                        }]
                    })
                );
                //Add the new shard server
                return _add_new_shard_on_server(req.rpc_params.shard, req.rpc_params.ip);
            } else if (req.rpc_params.role === 'REPLICA') {
                //Server is joining as a replica set member to an existing shard, update shard chain topology
                //And add an appropriate server
                return _add_new_replicaset_on_server(req.rpc_params.shard, req.rpc_params.ip);
            } else {
                dbg.error('Unknown role', req.rpc_params.role, 'recieved, ignoring');
                throw new Error('Unknown server role ' + req.rpc_params.role);
            }
        })
        .then(function() {
            dbg.log0('Added member, publishing updated topology');
            //Mongo servers are up, update entire cluster with the new topology
            return _publish_to_cluster('news_updated_topology', cutil.get_topology());
        });
}

function news_config_servers(req) {
    dbg.log0('Recieved news_config_servers', req.rpc_params);
    //Verify we recieved news on the cluster we are joined to
    cutil.verify_cluster_id(req.rpc_params.cluster_id);

    //Update our view of the topology
    cutil.update_cluster_info({
        config_servers: req.rpc_params.IPs
    });

    if (req.rpc_params.IPs.length < 3) {
        dbg.log('Current config replicaset < 3, not starting mongos services');
        return;
    }

    //We have a valid config replica set, start the mongos service
    return MongoCtrl.add_new_mongos(cutil.extract_servers_ip(
        cutil.get_topology().config_servers
    ));

    //TODO:: NBNB Update connection string for our mongo connections, currently only seems needed for
    //Replica sets =>
    //Need to close current connections and re-open (bg_worker, all webservers)
    //probably best to use publish_to_cluster
}

function news_updated_topology(req) {
    dbg.log0('Recieved news_updated_topology', req.rpc_params);
    //Verify we recieved news on the cluster we are joined to
    cutil.verify_cluster_id(req.rpc_params.cluster_id);

    //Update our view of the topology
    cutil.update_cluster_info(req.rpc_params.topology);
    return;
}

function heartbeat(req) {
    //TODO:: ...
    dbg.error('Clustering HB currently not implemented');
}


//
//Internals Cluster Control
//
function _add_new_shard_on_server(shardname, ip, first_shard) {
    // "cache" current topology until all changes take affect, since we are about to lose mongo
    // until the process is done
    let current_topology = cutil.get_topology();
    let topology_updates = {};
    dbg.log0('Adding shard, new topology', current_topology);

    //Actually add a new mongo shard instance
    return P.when(MongoCtrl.add_new_shard_server(shardname, first_shard))
        .then(function() {
            dbg.log0('Checking current config servers set, currently contains', current_topology.config_servers.length, 'servers');
            if (current_topology.config_servers.length === 3) { //Currently stay with a repset of 3 for config
                //We already have a config replica set of 3, simply set up a mongos instance
                return MongoCtrl.add_new_mongos(cutil.extract_servers_ip(
                    current_topology.config_servers
                ));
            } else { // < 3 since we don't add once we reach 3, add this server as config as well
                var updated_cfg = current_topology.config_servers;
                updated_cfg.push({
                    address: ip
                });
                topology_updates.config_servers = updated_cfg;

                return _add_new_config_on_server(cutil.extract_servers_ip(updated_cfg), first_shard)
                    .then(function() {
                      //add the new shard in the mongo configuration
                      return P.when(MongoCtrl.add_member_shard(shardname, ip));
                    })
                    .then(function() {
                        dbg.log0('Updating topology in mongo');
                        return cutil.update_cluster_info(topology_updates);
                    })
                    .then(function() {
                        dbg.log0('Added', ip, 'as a config server publish to cluster');
                        return _publish_to_cluster('news_config_servers', {
                            IPs: updated_cfg,
                            cluster_id: current_topology.cluster_id
                        });
                    });
            }
        });
}

function _add_new_replicaset_on_server(shardname, ip) {
    var shard_idx = _.findIndex(cutil.get_topology().shards, function(s) {
        return shardname === s.name;
    });

    //No Such shard
    if (shard_idx === -1) {
        throw new Error('Cannot add RS member to non-existing shard');
    }

    cutil.update_cluster_info(
        cutil.get_topology().shards[shard_idx].servers.push({
            address: ip
        })
    );

    return MongoCtrl.add_replica_set_member(shardname)
        .then(function() {

            var rs_length = cutil.get_topology().shards[shard_idx].servers.length;
            if (rs_length === 3) {
                //Initiate replica set and add all members
                return MongoCtrl.initiate_replica_set(shardname, cutil.extract_servers_ip(
                    cutil.get_topology().shards[shard_idx].servers
                ));
            } else if (rs_length > 3) {
                //joining an already existing and functioning replica set, add new member
                return MongoCtrl.add_member_to_replica_set(shardname, cutil._extract_servers_ip(
                    cutil._get_topology().shards[shard_idx].servers
                ));
            } else {
                //2 servers, nothing to be done yet. RS will be activated on the 3rd join
                return;
            }
        });
}

function _add_new_config_on_server(cfg_array, first_shard) {
    dbg.log0('Adding new local config server');
    return P.when(MongoCtrl.add_new_config())
        .then(function() {
            dbg.log0('Adding mongos on config array', cfg_array);
            return MongoCtrl.add_new_mongos(cfg_array);
        })
        .then(function() {
            dbg.log0('Updating config replica set, initiate_replica_set=', first_shard ? 'true' : 'false');
            if (first_shard) {
                return MongoCtrl.initiate_replica_set(config.MONGO_DEFAULTS.CFG_RSET_NAME, cfg_array, true); //3rd param /*config set*/
            } else {
                return MongoCtrl.add_member_to_replica_set(config.MONGO_DEFAULTS.CFG_RSET_NAME, cfg_array, true); //3rd param /*config set*/
            }
        });
}

function _publish_to_cluster(apiname, req_params) {
    var servers = [];
    _.each(cutil.get_topology().shards, function(shard) {
        _.each(shard.servers, function(single_srv) {
            servers.push(single_srv.address);
        });
    });

    dbg.log0('Sending cluster news', apiname, 'to', servers, 'with', req_params);
    return P.each(servers, function(server) {
        return server_rpc.client.cluster_server[apiname](req_params, {
            address: 'ws://' + server + ':8080',
            timeout: 60000 //60s
        });
    });
}

//
//Internals Utiliy
//

function _get_secret() {
    return this._secret;
}

// EXPORTS
exports._init = _init;
exports.new_cluster_info = new_cluster_info;
exports.add_member_to_cluster = add_member_to_cluster;
exports.join_to_cluster = join_to_cluster;
exports.news_config_servers = news_config_servers;
exports.news_updated_topology = news_updated_topology;
exports.heartbeat = heartbeat;
