# Third-party software in Castpane.app

Besides Castpane's own code (MIT, see [LICENSE](../LICENSE)), the app bundles:

| What | Where in the app | License | Source |
| --- | --- | --- | --- |
| Node.js | `Contents/Resources/node` | MIT and others (its own `LICENSE`) | https://github.com/nodejs/node |
| The server's npm packages | `Contents/Resources/server/node_modules` | each package's own license file | npm |
| node-datachannel (the direct link) | `Contents/Resources/server/node_modules/node-datachannel` and `@node-datachannel/darwin-*` | MPL-2.0 | https://github.com/murat-dogan/node-datachannel |
| libdatachannel, inside node-datachannel's binary | (built in) | MPL-2.0 | https://github.com/paullouisageneau/libdatachannel |
| libjuice (ICE), inside it | (built in) | MPL-2.0 | https://github.com/paullouisageneau/libjuice |
| usrsctp (SCTP), inside it | (built in) | BSD-3-Clause | https://github.com/sctplab/usrsctp |
| libsrtp, inside it | (built in) | BSD-3-Clause | https://github.com/cisco/libsrtp |
| OpenSSL 3, inside it | (built in) | Apache-2.0 | https://github.com/openssl/openssl |
| plog, inside it | (built in) | MIT | https://github.com/SergiusTheBest/plog |

cloudflared is not bundled: the app uses one already installed, or downloads Cloudflare's own
release and checks it.
The MPL-2.0 parts are used unchanged, as published on npm; their source is at the addresses
above.
