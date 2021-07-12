import libp2p from 'libp2p'
import type { Handler, Stream } from 'libp2p'
import { durations } from '@hoprnet/hopr-utils'

import { NOISE } from 'libp2p-noise'

const MPLEX = require('libp2p-mplex')

import { HoprConnect } from '../src'
import { Multiaddr } from 'multiaddr'
import PeerId from 'peer-id'
import { getIdentity } from './identities'
import pipe from 'it-pipe'
import yargs from 'yargs/yargs'

const TEST_PROTOCOL = '/hopr-connect/test/0.0.1'

async function main() {
  const argv = yargs(process.argv.slice(2))
    .option('clientPort', {
      describe: 'client port',
      type: 'number',
      demandOption: true
    })
    .option('clientIdentityName', {
      describe: 'client identity name',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed'],
      demandOption: true
    })
    .option('relayPort', {
      describe: 'relayPort port',
      type: 'number',
      demandOption: true
    })
    .option('relayIdentityName', {
      describe: 'identity name of a relay',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed'],
      demandOption: true
    })
    .option('counterPartyIdentityName', {
      describe: 'identity name of a counter party to send msg to',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed']
    })
    .option('command', {
      describe: 'example: --command.name dial --command.targetIdentityName charly',
      type: 'string',
    })
    .parseSync()

  
  const relayPeerId = await PeerId.createFromPrivKey(getIdentity(argv.relayIdentityName))

  const RELAY_ADDRESS = new Multiaddr(`/ip4/127.0.0.1/tcp/${argv.relayPort}/p2p/${relayPeerId.toB58String()}`)

  const clientPeerId = await PeerId.createFromPrivKey(getIdentity(argv.clientIdentityName))

  const node = await libp2p.create({
    peerId: clientPeerId,
    addresses: {
      listen: [new Multiaddr(`/ip4/0.0.0.0/tcp/${argv.clientPort}/p2p/${clientPeerId.toB58String()}`)]
    },
    modules: {
      transport: [HoprConnect],
      streamMuxer: [MPLEX],
      connEncryption: [NOISE]
    },
    config: {
      transport: {
        HoprConnect: {
          bootstrapServers: [RELAY_ADDRESS],
          // simulates a NAT
          // DO NOT use this in production
          __noDirectConnections: true,
          __noWebRTCUpgrade: false
        }
      },
      peerDiscovery: {
        autoDial: false
      }
    },
    dialer: {
      // Temporary fix
      addressSorter: (ma: Multiaddr) => ma
    }
  })

  await node.start()

  node.handle(TEST_PROTOCOL, (struct: Handler) => {
    pipe(
      struct.stream.source,
      (source: Stream['source']) => {
        return (async function* () {
          for await (const msg of source) {
            const decoded = new TextDecoder().decode(msg.slice())

            console.log(`Received message <${decoded}>`)

            yield new TextEncoder().encode(`Echoing <${decoded}>`)
          }
        })()
      },
      struct.stream.sink
    )
  })
  console.log(`running client ${argv.clientIdentityName} on port ${argv.clientPort}`)

  for(const cmdString of argv.command) {
    const tokens = cmdString.split(',')
    const cmd = tokens[0]
    switch(cmd) {
      case 'wait':
      {
        const waitForSecs = parseFloat(tokens[1])
        console.log(`waiting ${waitForSecs} secs`)
        await new Promise((resolve) => setTimeout(resolve, durations.seconds(waitForSecs)))
        console.log(`finished waiting`)
        break
      }
      case 'dial': 
      {
        const targetIdentityName = tokens[1]
        const targetPort = parseInt(tokens[2])
        const targetPeerId = await PeerId.createFromPrivKey(getIdentity(targetIdentityName))
        const targetAddress = new Multiaddr(`/ip4/127.0.0.1/tcp/${targetPort}/p2p/${targetPeerId.toB58String()}`)
        console.log(`dialing ${targetIdentityName}`)
        await node.dial(targetAddress)
        console.log(`dialed`)
        break
      }
      case 'msg':
      {
        const relayIdentityName = tokens[1]
        const targetIdentityName = tokens[2]
        const msg = tokens[3]
        
        const targetPeerId = await PeerId.createFromPrivKey(getIdentity(targetIdentityName))
        const relayPeerId = await PeerId.createFromPrivKey(getIdentity(relayIdentityName))
        //@ts-ignore
        let conn: Handler

        console.log(`msg: dialing ${targetIdentityName} though relay ${relayIdentityName}`)
        conn = await node.dialProtocol(
          new Multiaddr(`/p2p/${relayPeerId}/p2p-circuit/p2p/${targetPeerId.toB58String()}`),
          TEST_PROTOCOL
        )
        console.log(`piping msg: ${msg}`)
        
        await pipe([new TextEncoder().encode(msg)], conn.stream, async (source: Stream['source']) => {
          for await (const msg of source) {
            const decoded = new TextDecoder().decode(msg.slice())

            console.log(`Received <${decoded}>`)
          }
        })  
        console.log(`sent msg`)               
     }
    } 
  }
}

main()
