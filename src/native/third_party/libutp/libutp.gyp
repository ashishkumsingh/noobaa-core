{
    'includes': ['../../common.gypi'],
    'configurations': {
        'Debug': {
            'defines': ['_DEBUG', 'UTP_DEBUG_LOGGING'],
        },
        'Release': {
            'defines!': ['_DEBUG', 'UTP_DEBUG_LOGGING'],
        }
    },
    'targets': [{
        'target_name': 'libutp',
        'type': 'static_library',
        'conditions' : [
            [ 'OS=="mac" ', {
                'defines': ['POSIX']
            }],
            [ 'OS=="linux" ', {
                'defines': ['POSIX']
            }]
        ],
        'sources': [
            'utp.h',
            'utp_api.cpp',
            'utp_callbacks.cpp',
            'utp_callbacks.h',
            'utp_hash.cpp',
            'utp_hash.h',
            'utp_internal.cpp',
            'utp_internal.h',
            'utp_packedsockaddr.cpp',
            'utp_packedsockaddr.h',
            'utp_templates.h',
            'utp_types.h',
            'utp_utils.cpp',
            'utp_utils.h',
        ],
    }, {
        'target_name': 'ucat',
        'type': 'executable',
        'conditions' : [
            [ 'OS=="mac"', {
                'defines': ['POSIX']
            }],
            [ 'OS=="linux" ', {
                'defines': ['POSIX']
            }]
        ],
        'dependencies': ['libutp'],
        'sources': ['ucat.c']
    }]
}
