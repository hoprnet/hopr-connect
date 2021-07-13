import libp2p from 'libp2p'
import type { Handler, Stream } from 'libp2p'
import { durations } from '@hoprnet/hopr-utils'

import { NOISE } from 'libp2p-noise'

const MPLEX = require('libp2p-mplex')

import { HoprConnect } from '../src'
import { Multiaddr } from 'multiaddr'
import pipe from 'it-pipe'
import yargs from 'yargs/yargs'
import { peerIdForIdentity } from './util'
import PeerId from 'peer-id'
import LibP2P from 'libp2p'

const TEST_PROTOCOL = '/hopr-connect/test/0.0.1'

async function startNode({ peerId, port, bootstrapAddress }: {
  peerId: PeerId,
  port: number,
  bootstrapAddress?: Multiaddr,
}) {  
  console.log(`starting node, bootstrap address ${bootstrapAddress}`)
  const node = await libp2p.create({
    peerId,
    addresses: {
      listen: [new Multiaddr(`/ip4/0.0.0.0/tcp/${port}/p2p/${peerId.toB58String()}`)]
    },
    modules: {
      transport: [HoprConnect],
      streamMuxer: [MPLEX],
      connEncryption: [NOISE]
    },
    config: {
      transport: {
        HoprConnect: {
          bootstrapServers: bootstrapAddress ? [bootstrapAddress] : [],
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
  console.log(`node started`)
  return node
}

function handleProtocol(node: LibP2P) {
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
}

async function executeCommands({ node, cmds }: { node: LibP2P, cmds: string[] }) {
  for(const cmdString of cmds) {
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
        const targetPeerId = await peerIdForIdentity(targetIdentityName)
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
        
        const targetPeerId = await peerIdForIdentity(targetIdentityName)
        const relayPeerId = await peerIdForIdentity(relayIdentityName)
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

async function main() {
  const argv = yargs(process.argv.slice(2))
    .option('port', {
      describe: 'node port',
      type: 'number',
      demandOption: true
    })
    .option('identityName', {
      describe: 'node identity name',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed'],
      demandOption: true
    })
    .option('bootstrapPort', {
      describe: 'bootstrap node port',
      type: 'number',
    })
    .option('bootstrapIdentityName', {
      describe: 'identity name of a boostrap server',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed'],
    })
    .option('command', {
      describe: 'example: --command.name dial --command.targetIdentityName charly',
      type: 'string',
    })
    .parseSync()

  
  let bootstrapAddress: Multiaddr | undefined
  
  if(argv.bootstrapPort != null && argv.bootstrapIdentityName != null) {
    const bootstrapPeerId = await peerIdForIdentity(argv.bootstrapIdentityName)  
    bootstrapAddress = new Multiaddr(`/ip4/127.0.0.1/tcp/${argv.bootstrapPort}/p2p/${bootstrapPeerId.toB58String()}`)
  }
  const peerId = await peerIdForIdentity(argv.identityName)

  console.log(`running node ${argv.identityName} on port ${argv.port}`)
  const node = await startNode({ peerId, port: argv.port, bootstrapAddress })
  handleProtocol(node)
  
  if(argv.command) {
    await executeCommands({ node, cmds: [argv.command].flat() })
  }  
}

main()
