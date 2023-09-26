/* Copyright (C) 2020 NooBaa */
'use strict';

require('../util/dotenv').load();
require('aws-sdk/lib/maintenance_mode_message').suppress = true;

const dbg = require('../util/debug_module')(__filename);
if (!dbg.get_process_name()) dbg.set_process_name('nsfs');
dbg.original_console();

const config = require('../../config');

const fs = require('fs');
const util = require('util');
const minimist = require('minimist');

require('../server/system_services/system_store').get_instance({ standalone: true });

//const js_utils = require('../util/js_utils');
const nb_native = require('../util/nb_native');
//const schema_utils = require('../util/schema_utils');
//const RpcError = require('../rpc/rpc_error');
const ObjectSDK = require('../sdk/object_sdk');
const NamespaceFS = require('../sdk/namespace_fs');
const BucketSpaceSimpleFS = require('../sdk/bucketspace_simple_fs');
const BucketSpaceFS = require('../sdk/bucketspace_fs');
const SensitiveString = require('../util/sensitive_string');
const endpoint_stats_collector = require('../sdk/endpoint_stats_collector');
const { get_schema } = require('../api');
//const { RPC_BUFFERS } = require('../rpc');

const HELP = `
Help:

    "nsfs" is a noobaa-core command runs a local S3 endpoint on top of a filesystem.
    Each sub directory of the root filesystem represents an S3 bucket.
    Objects data and meta-data is stored and retrieved from the files.
    For more information refer to the noobaa docs.
`;

const USAGE = `
Usage:

    node src/cmd/nsfs <root-path> [options...]
`;

const ARGUMENTS = `
Arguments:

    <root-path>      Set the root of the filesystem where each subdir is a bucket.
`;

const OPTIONS = `
Options:

    --http_port <port>         (default 6001)   Set the S3 endpoint listening HTTP port to serve.
    --https_port <port>        (default 6443)   Set the S3 endpoint listening HTTPS port to serve.
    --https_port_sts <port>    (default -1)     Set the S3 endpoint listening HTTPS port for STS.
    --metrics_port <port>      (default -1)     Set the metrics listening port for prometheus.
    --forks <n>                (default none)   Forks spread incoming requests (config.ENDPOINT_FORKS used if flag is not provided).
    --debug <level>            (default 0)      Increase debug level.

    ## single user mode

    --uid <uid>          (default as process)   Send requests to the Filesystem with uid.
    --gid <gid>          (default as process)   Send requests to the Filesystem with gid.
    --access_key <key>      (default none)      Authenticate incoming requests for this access key only (default is no auth).
    --secret_key <key>      (default none)      The secret key pair for the access key.

    ## multi user mode

    --iam_json_schema                           Print the json schema of the identity files in iam dir.
    --iam_ttl <seconds>     (default 60)        Identities expire after this amount of time, and re-read from the FS.
    --config_root <dir>     (default none)      Configuration files for Noobaa standalon NSFS. It includes config files for environment variables(<config_root>/.env), 
                                                local configuration(<config_root>/config-local.js), authentication (<config_root>/accounts/<access-key>.json) and 
                                                bucket schema (<config_root>/buckets/<bucket-name>.json).

    ## features

    --backend <fs>          (default none)      Use custom backend fs to CEPH_FS 'GPFS', 'NFSv4').
    --versioning <mode>   (default DISABLED)    Set versioning mode to DISABLED | ENABLED | SUSPENDED.

`;

const ANONYMOUS_AUTH_WARNING = `

WARNING:

    !!! AUTHENTICATION is not enabled !!!
    
    This means that any access/secret signature or unsigned (anonymous) requests
    will allow access to the filesystem over the network.
`;

function print_usage() {
    console.warn(HELP);
    console.warn(USAGE.trimStart());
    console.warn(ARGUMENTS.trimStart());
    console.warn(OPTIONS.trimStart());
    process.exit(1);
}

const IAM_JSON_SCHEMA = get_schema('account_api#/definitions/account_info');

class NsfsObjectSDK extends ObjectSDK {

    constructor(fs_root, fs_config, account, versioning, config_root) {

        // const rpc_client_hooks = new_rpc_client_hooks();
        // rpc_client_hooks.account.read_account_by_access_key = async ({ access_key }) => {
        //     if (access_key) {
        //         return { access_key };
        //     }
        // };
        // rpc_client_hooks.bucket.read_bucket_sdk_info = async ({ name }) => {
        //     if (name) {
        //         return { name };
        //     }
        // };
        let bucketspace;
        if (config_root) {
            bucketspace = new BucketSpaceFS({ config_root });
        } else {
            bucketspace = new BucketSpaceSimpleFS({ fs_root });
        }
        super({
            rpc_client: null,
            internal_rpc_client: null,
            object_io: null,
            bucketspace,
            stats: endpoint_stats_collector.instance(),
        });
        this.nsfs_fs_root = fs_root;
        this.nsfs_fs_config = fs_config;
        this.nsfs_account = account;
        this.nsfs_versioning = versioning;
        this.nsfs_namespaces = {};
        if (!config_root) {
            this._get_bucket_namespace = bucket_name => this._get_single_bucket_namespace(bucket_name);
        }

    }

    async _get_single_bucket_namespace(bucket_name) {
        const existing_ns = this.nsfs_namespaces[bucket_name];
        if (existing_ns) return existing_ns;
        const ns_fs = new NamespaceFS({
            fs_backend: this.nsfs_fs_config.backend,
            bucket_path: this.nsfs_fs_root + '/' + bucket_name,
            bucket_id: 'nsfs',
            namespace_resource_id: undefined,
            access_mode: undefined,
            versioning: this.nsfs_versioning,
            stats: endpoint_stats_collector.instance(),
            force_md5_etag: false,
        });
        this.nsfs_namespaces[bucket_name] = ns_fs;
        return ns_fs;
    }

    // async load_requesting_account(auth_req) {
    //     const access_key = this.nsfs_account.access_keys?.[0]?.access_key;
    //     if (access_key) {
    //         const token = this.get_auth_token();
    //         if (!token) {
    //             throw new RpcError('UNAUTHORIZED', `Anonymous access to bucket not allowed`);
    //         }
    //         if (token.access_key !== access_key.unwrap()) {
    //             throw new RpcError('INVALID_ACCESS_KEY_ID', `Account with access_key not found`);
    //         }
    //     }
    //     this.requesting_account = this.nsfs_account;
    // }

    // async read_bucket_sdk_policy_info(bucket_name) {
    //     return {
    //         s3_policy: {
    //             version: '2012-10-17',
    //             statement: [{
    //                 effect: 'allow',
    //                 action: ['*'],
    //                 resource: ['*'],
    //                 principal: [new SensitiveString('*')],
    //             }]
    //         },
    //         system_owner: new SensitiveString('nsfs'),
    //         bucket_owner: new SensitiveString('nsfs'),
    //     };
    // }

    // async read_bucket_usage_info() { return undefined; }
    // async read_bucket_sdk_website_info() { return undefined; }
    // async read_bucket_sdk_namespace_info() { return undefined; }
    // async read_bucket_sdk_caching_info() { return undefined; }

}

async function main(argv = minimist(process.argv.slice(2))) {
    try {
        config.DB_TYPE = 'none';
        config.NSFS_VERSIONING_ENABLED = true;

        if (argv.help || argv.h) return print_usage();
        if (argv.debug) {
            const debug_level = Number(argv.debug) || 5;
            dbg.set_module_level(debug_level, 'core');
            nb_native().fs.set_debug_level(debug_level);
        }
        if (argv.iam_json_schema) {
            console.log(JSON.stringify(IAM_JSON_SCHEMA.schema, null, 2));
            return;
        }

        const http_port = Number(argv.http_port) || 6001;
        const https_port = Number(argv.https_port) || 6443;
        const https_port_sts = Number(argv.https_port_sts) || -1;
        const metrics_port = Number(argv.metrics_port) || -1;
        const forks = Number(argv.forks) || 0;
        const uid = Number(argv.uid) || process.getuid();
        const gid = Number(argv.gid) || process.getgid();
        const access_key = argv.access_key && new SensitiveString(String(argv.access_key));
        const secret_key = argv.secret_key && new SensitiveString(String(argv.secret_key));
        const config_root = argv.config_root ? String(argv.config_root) : '';
        const iam_ttl = Number(argv.iam_ttl ?? 60);
        const backend = argv.backend || (process.env.GPFS_DL_PATH ? 'GPFS' : '');
        const versioning = argv.versioning || 'DISABLED';

        const fs_root = argv._[0] || '';

        const fs_config = {
            uid,
            gid,
            backend,
            warn_threshold_ms: config.NSFS_WARN_THRESHOLD_MS,
        };
        const account = {
            email: new SensitiveString('nsfs@noobaa.io'),
            nsfs_account_config: fs_config,
            access_keys: access_key && [{ access_key, secret_key }],
        };

        if (fs_root !== '' && !fs.existsSync(fs_root)) {
            console.error('Error: Root path not found', fs_root);
            return print_usage();
        }
        if (config_root && access_key) {
            console.error('Error: Access key and IAM dir cannot be used together');
            return print_usage();
        }
        if (Boolean(access_key) !== Boolean(secret_key)) {
            console.error('Error: Access and secret keys should be either both set or else both unset');
            return print_usage();
        }
        if (!access_key && !config_root) {
            console.log(ANONYMOUS_AUTH_WARNING);
        }

        console.log('nsfs: setting up ...', {
            fs_root,
            http_port,
            https_port,
            https_port_sts,
            metrics_port,
            backend,
            forks,
            access_key,
            secret_key,
            uid,
            gid,
            config_root,
            iam_ttl,
        });

        const endpoint = require('../endpoint/endpoint');
        await endpoint.main({
            http_port,
            https_port,
            https_port_sts,
            metrics_port,
            forks,
            init_request_sdk: (req, res) => {
                req.object_sdk = new NsfsObjectSDK(fs_root, fs_config, account, versioning, config_root);
            }
        });

        console.log('nsfs: listening on', util.inspect(`http://localhost:${http_port}`));
        console.log('nsfs: listening on', util.inspect(`https://localhost:${https_port}`));

    } catch (err) {
        console.error('nsfs: exit on error', err.stack || err);
        process.exit(2);
    }
}

// TODO: uncomment
// /**
//  * @returns {nb.APIClient}
//  */
// function new_rpc_client_hooks() {
//     return {
//         account: {},
//         bucket: {},
//         auth: {},
//         system: {},
//         tier: {},
//         node: {},
//         host: {},
//         object: {},
//         events: {},
//         agent: {},
//         block_store: {},
//         stats: {},
//         scrubber: {},
//         debug: {},
//         redirector: {},
//         tiering_policy: {},
//         pool: {},
//         cluster_server: {},
//         cluster_internal: {},
//         server_inter_process: {},
//         hosted_agents: {},
//         func: {},
//         func_node: {},
//         replication: {},
//         options: {},
//         RPC_BUFFERS,
//         async create_auth_token(params) {
//             return {};
//         },
//         async create_access_key_auth(params) {
//             return {};
//         },
//         async create_k8s_auth(params) {
//             return {};
//         },
//     };
// }
// 

exports.main = main;

if (require.main === module) main();
