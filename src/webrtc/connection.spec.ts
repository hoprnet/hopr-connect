/// <reference path="../@types/it-handshake.ts" />
/// <reference path="../@types/it-pair.ts" />

import handshake from 'it-handshake'
import Pair from 'it-pair'
import { Multiaddr } from 'multiaddr'

import { WebRTCConnection, MigrationStatus } from './connection'
import { encodeWithLengthPrefix } from '../utils'
import { privKeyToPeerId, stringToU8a, u8aEquals } from '@hoprnet/hopr-utils'
import pushable from 'it-pushable'

import { EventEmitter } from 'events'
import assert from 'assert'

// const Alice = privKeyToPeerId(stringToU8a(`0xf8860ccb336f4aad751f55765b4adbefc538f8560c21eed6fbc9940d0584eeca`))
const Bob = privKeyToPeerId(stringToU8a(`0xf8860ccb336f4aad751f55765b4adbefc538f8560c21eed6fbc9940d0584eeca`))

describe('test webrtc connection', function () {
  it('exchange messages without upgrade', async function () {
    const AliceBob = Pair()
    const BobAlice = Pair()

    const conn = new WebRTCConnection(
      Bob,
      { connections: new Map() } as any,
      {
        source: BobAlice.source,
        sink: AliceBob.sink
      } as any,
      new EventEmitter() as any
    )

    const AliceShaker = handshake<Uint8Array>(conn)
    const BobShaker = handshake<Uint8Array>({
      source: AliceBob.source,
      sink: BobAlice.sink
    })

    const ATTEMPTS = 5

    for (let i = 0; i < ATTEMPTS; i++) {
      const firstMessage = new TextEncoder().encode(`first message`)
      AliceShaker.write(firstMessage)

      assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.from([MigrationStatus.NOT_DONE, ...firstMessage])))

      const secondMessage = new TextEncoder().encode(`second message`)
      BobShaker.write(Uint8Array.from([MigrationStatus.NOT_DONE, ...secondMessage]))

      assert(u8aEquals((await AliceShaker.read()).slice(), secondMessage))
    }
  })

  it('send DONE after webRTC connect event', async function () {
    const AliceBob = Pair()
    const BobAlice = Pair()

    const webRTCInstance = new EventEmitter()

    new WebRTCConnection(
      Bob,
      { connections: new Map() } as any,
      {
        source: BobAlice.source,
        sink: AliceBob.sink
      } as any,
      webRTCInstance as any
    )

    const BobShaker = handshake<Uint8Array>({
      source: AliceBob.source,
      sink: BobAlice.sink
    })

    webRTCInstance.emit(`connect`)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.of(MigrationStatus.DONE)))
  })

  it('sending messages after webRTC error event', async function () {
    const AliceBob = Pair()
    const BobAlice = Pair()

    const webRTCInstance = new EventEmitter()

    Object.assign(webRTCInstance, {
      destroy: () => {}
    })

    const conn = new WebRTCConnection(
      Bob,
      { connections: new Map() } as any,
      {
        source: BobAlice.source,
        sink: AliceBob.sink
      } as any,
      webRTCInstance as any
    )

    const AliceShaker = handshake<Uint8Array>(conn)
    const BobShaker = handshake<Uint8Array>({
      source: AliceBob.source,
      sink: BobAlice.sink
    })

    webRTCInstance.emit(`error`)

    const firstMessage = new TextEncoder().encode(`first message`)
    AliceShaker.write(firstMessage)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.from([MigrationStatus.NOT_DONE, ...firstMessage])))

    const secondMessage = new TextEncoder().encode(`second message`)
    BobShaker.write(Uint8Array.from([MigrationStatus.NOT_DONE, ...secondMessage]))

    assert(u8aEquals((await AliceShaker.read()).slice(), secondMessage))
  })

  it('exchange messages and send DONE after webRTC connect event', async function () {
    const AliceBob = Pair()
    const BobAlice = Pair()

    const webRTCInstance = new EventEmitter()

    const conn = new WebRTCConnection(
      Bob,
      { connections: new Map() } as any,
      {
        source: BobAlice.source,
        sink: AliceBob.sink
      } as any,
      webRTCInstance as any
    )

    const AliceShaker = handshake<Uint8Array>(conn)
    const BobShaker = handshake<Uint8Array>({
      source: AliceBob.source,
      sink: BobAlice.sink
    })

    const firstMessage = new TextEncoder().encode(`first message`)
    AliceShaker.write(firstMessage)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.from([MigrationStatus.NOT_DONE, ...firstMessage])))

    const secondMessage = new TextEncoder().encode(`second message`)
    BobShaker.write(Uint8Array.from([MigrationStatus.NOT_DONE, ...secondMessage]))

    assert(u8aEquals((await AliceShaker.read()).slice(), secondMessage))

    webRTCInstance.emit(`connect`)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.of(MigrationStatus.DONE)))
  })

  it('exchange messages through webRTC', async function () {
    const AliceBob = Pair()
    const BobAlice = Pair()

    const BobAliceWebRTC = pushable<Uint8Array>()
    const AliceBobWebRTC = pushable<Uint8Array>()

    const webRTCInstance = new EventEmitter()

    // Turn faked WebRTC instance into an async iterator (read) and writable stream (write)
    Object.assign(webRTCInstance, {
      [Symbol.asyncIterator]() {
        return (async function* () {
          for await (const msg of BobAliceWebRTC) {
            yield msg
          }
        })()
      },
      write(msg: Uint8Array) {
        AliceBobWebRTC.push(msg)
      },
      writable: true,
      destroy() {
        AliceBobWebRTC.end()
      }
    })

    const conn = new WebRTCConnection(
      Bob,
      { connections: new Map() } as any,
      {
        source: BobAlice.source,
        sink: AliceBob.sink,
        remoteAddr: new Multiaddr(`/p2p/${Bob.toB58String()}`)
      } as any,
      webRTCInstance as any
    )

    const AliceShaker = handshake<Uint8Array>(conn)
    const BobShaker = handshake<Uint8Array>({
      source: AliceBob.source,
      sink: BobAlice.sink
    })

    const firstMessage = new TextEncoder().encode(`first message`)
    AliceShaker.write(firstMessage)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.from([MigrationStatus.NOT_DONE, ...firstMessage])))

    const secondMessage = new TextEncoder().encode(`second message`)
    BobShaker.write(Uint8Array.from([MigrationStatus.NOT_DONE, ...secondMessage]))

    assert(u8aEquals((await AliceShaker.read()).slice(), secondMessage))

    webRTCInstance.emit(`connect`)

    assert(u8aEquals((await BobShaker.read()).slice(), Uint8Array.of(MigrationStatus.DONE)))

    BobShaker.write(Uint8Array.of(MigrationStatus.DONE))

    const msgSentThroughWebRTC = new TextEncoder().encode(`message that is sent through faked WebRTC`)
    BobAliceWebRTC.push(encodeWithLengthPrefix(Uint8Array.from([MigrationStatus.NOT_DONE, ...msgSentThroughWebRTC])))

    assert(u8aEquals((await AliceShaker.read()).slice(), msgSentThroughWebRTC))

    const msgSentBackThroughWebRTC = new TextEncoder().encode(`message that is sent back through faked WebRTC`)

    AliceShaker.write(msgSentBackThroughWebRTC)

    assert(
      u8aEquals(
        (await (AliceBobWebRTC as any).next()).value,
        encodeWithLengthPrefix(Uint8Array.from([MigrationStatus.NOT_DONE, ...msgSentBackThroughWebRTC]))
      )
    )
  })
})
