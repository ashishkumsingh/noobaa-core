// this module is written for both nodejs.
'use strict';

var _ = require('lodash');
var Q = require('q');
var assert = require('assert');
var moment = require('moment');
var LRU = require('noobaa-util/lru');
var db = require('./db');
var rest_api = require('../util/rest_api');
var size_utils = require('../util/size_utils');
var account_api = require('../api/account_api');
var node_monitor = require('./node_monitor');
var express_jwt = require('express-jwt');
var jwt = require('jsonwebtoken');


var account_server = new account_api.Server({
    // CRUD
    create_account: create_account,
    read_account: read_account,
    update_account: update_account,
    delete_account: delete_account,
});

module.exports = account_server;



//////////
// CRUD //
//////////


function create_account(req) {
    var info = _.pick(req.rest_params, 'name', 'email', 'password');

    return Q.fcall(
        function() {
            return db.Account.create(info);
        }
    ).then(
        function(account) {
            return _.pick(account, 'id');
        },
        function(err) {
            if (err.code === 11000) {
                throw new Error('account already exists');
            } else {
                console.error('FAILED create_account', err);
                throw new Error('failed create account');
            }
        }
    );
}


function read_account(req) {
    return req.load_account('force_miss').then(
        function() {
            return _.pick(req.account, 'id', 'name', 'email', 'systems_role');
        }
    );
}


function update_account(req) {
    return req.load_account('force_miss').then(
        function() {
            db.AccountCache.invalidate(req.account.id);
            var info = _.pick(req.rest_params, 'name', 'email', 'password');
            return db.Account.findByIdAndUpdate(req.account.id, info).exec();
        }
    ).then(null,
        function(err) {
            console.error('FAILED update_account', err);
            throw new Error('update account failed');
        }
    ).thenResolve();
}


function delete_account(req) {
    return req.load_account('force_miss').then(
        function() {
            db.AccountCache.invalidate(req.account.id);
            return db.Account.findByIdAndUpdate(req.account.id, {
                deleted: new Date()
            }).exec();
        }
    ).then(null,
        function(err) {
            console.error('FAILED delete_account', err);
            throw new Error('delete account failed');
        }
    ).thenResolve();
}
