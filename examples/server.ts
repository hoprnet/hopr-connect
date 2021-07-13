import libp2p from 'libp2p'

import { NOISE } from 'libp2p-noise'
const MPLEX = require('libp2p-mplex')

import { HoprConnect } from '../src'
import { Multiaddr } from 'multiaddr'
import yargs from 'yargs/yargs'
import { peerIdForIdentity } from './util'

async function main() {
  const argv = yargs(process.argv.slice(2))
    .option('serverPort', {
      describe: 'server port name',
      type: 'number',
      demandOption: true
    })
    .option('serverIdentityName', {
      describe: 'server identity name',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed'],
      demandOption: true
    })
    .parseSync()

  const serverPeerId = await peerIdForIdentity(argv.serverIdentityName)  
}

main()
