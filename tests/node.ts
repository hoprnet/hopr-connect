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

function pipeEchoReplier(source: Stream['source']) {
  return (async function* () {
    for await (const encodedMsg of source) {
      const decoded = decodeMsg(encodedMsg.slice())

      console.log(`Received message <${decoded}>`)

      yield encodeMsg(`Echoing <${decoded}>`)
    }
  })()
}

async function pipeLogger(source: Stream['source']) {
  for await (const encodedMsg of source) {
    const decodedMsg = decodeMsg(encodedMsg.slice())
    console.log(`Received <${decodedMsg}>`)
  }
}

async function startNode({
  peerId,
  port,
  bootstrapAddress,
  noDirectConnections,
  noWebRTCUpgrade
}: {
  peerId: PeerId
  port: number
  bootstrapAddress?: Multiaddr
  noDirectConnections: boolean
  noWebRTCUpgrade: boolean
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
          __noDirectConnections: noDirectConnections,
          __noWebRTCUpgrade: noWebRTCUpgrade
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

  node.handle(TEST_PROTOCOL, (struct: Handler) => {
    pipe(
      struct.stream.source,
      pipeEchoReplier,
      struct.stream.sink
    )
  })

  await node.start()
  console.log(`node started`)
  return node
}

type CmdDef =
  | {
      cmd: 'wait'
      waitForSecs: number
    }
  | {
      cmd: 'dial'
      targetIdentityName: string
      targetPort: number
    }
  | {
      cmd: 'msg'
      msg: string
      targetIdentityName: string
      relayIdentityName: string
    }

function encodeMsg(msg: string): Uint8Array {
  return new TextEncoder().encode(msg)
}

function decodeMsg(encodedMsg: Uint8Array): string {
  return new TextDecoder().decode(encodedMsg)
}

async function executeCommands({ node, cmds }: { node: LibP2P; cmds: CmdDef[] }) {
  for (const cmdDef of cmds) {
    switch (cmdDef.cmd) {
      case 'wait': {
        console.log(`waiting ${cmdDef.waitForSecs} secs`)
        await new Promise((resolve) => setTimeout(resolve, durations.seconds(cmdDef.waitForSecs)))
        console.log(`finished waiting`)
        break
      }
      case 'dial': {
        const targetPeerId = await peerIdForIdentity(cmdDef.targetIdentityName)
        const targetAddress = new Multiaddr(`/ip4/127.0.0.1/tcp/${cmdDef.targetPort}/p2p/${targetPeerId.toB58String()}`)
        console.log(`dialing ${cmdDef.targetIdentityName}`)
        await node.dial(targetAddress)
        console.log(`dialed`)
        break
      }
      case 'msg': {
        const targetPeerId = await peerIdForIdentity(cmdDef.targetIdentityName)
        const relayPeerId = await peerIdForIdentity(cmdDef.relayIdentityName)
        //@ts-ignore
        let conn: Handler

        console.log(`msg: dialing ${cmdDef.targetIdentityName} though relay ${cmdDef.relayIdentityName}`)
        conn = await node.dialProtocol(
          new Multiaddr(`/p2p/${relayPeerId}/p2p-circuit/p2p/${targetPeerId.toB58String()}`),
          TEST_PROTOCOL
        )
        console.log(`sending msg '${cmdDef.msg}'`)

        const encodedMsg = encodeMsg(cmdDef.msg)
        await pipe(
          [encodedMsg], 
          conn.stream, 
          pipeLogger,
        )
        console.log(`sent ok`)
        break
      }
      default: {
        throw new Error(`unknown cmd: ${cmdDef}`)
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
      type: 'number'
    })
    .option('bootstrapIdentityName', {
      describe: 'identity name of a boostrap server',
      choices: ['alice', 'bob', 'charly', 'dave', 'ed']
    })
    .option('noDirectConnections', {
      type: 'boolean',
      demandOption: true
    })
    .option('noWebRTCUpgrade', {
      type: 'boolean',
      demandOption: true
    })
    .option('command', {
      describe: 'example: --command.name dial --command.targetIdentityName charly',
      type: 'string'
    })
    .option('script', {
      type: 'string',
      demandOption: true
    })
    .option('pipeFile', {
      type: 'string',
    })
    .coerce({
      script: (input) => JSON.parse(input.replace(/'/g, '"'))
    })
    .parseSync()

  let bootstrapAddress: Multiaddr | undefined

  if (argv.bootstrapPort != null && argv.bootstrapIdentityName != null) {
    const bootstrapPeerId = await peerIdForIdentity(argv.bootstrapIdentityName)
    bootstrapAddress = new Multiaddr(`/ip4/127.0.0.1/tcp/${argv.bootstrapPort}/p2p/${bootstrapPeerId.toB58String()}`)
  }
  const peerId = await peerIdForIdentity(argv.identityName)

  console.log(`running node ${argv.identityName} on port ${argv.port}`)
  const node = await startNode({
    peerId,
    port: argv.port,
    bootstrapAddress,
    noDirectConnections: argv.noDirectConnections,
    noWebRTCUpgrade: argv.noWebRTCUpgrade
  })

  await executeCommands({ node, cmds: argv.script })
}

main()
