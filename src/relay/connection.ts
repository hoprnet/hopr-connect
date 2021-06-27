/// <reference path="../@types/bl.ts" />
/// <reference path="../@types/libp2p.ts" />

import { Multiaddr } from 'multiaddr'
import type { MultiaddrConnection, Stream, StreamResult } from 'libp2p'
import { randomBytes } from 'crypto'
import Defer, { DeferredPromise } from 'p-defer'
import { RelayPrefix, ConnectionStatusMessages, StatusMessages } from '../constants'
import { u8aEquals, u8aToHex } from '@hoprnet/hopr-utils'
import Heap from 'heap-js'

import type { Instance as SimplePeer } from 'simple-peer'

import type PeerId from 'peer-id'

import Debug from 'debug'
import { EventEmitter } from 'events'
import { toU8aStream } from '../utils'
import { eagerIterator } from './utils'

const _log = Debug('hopr-connect')
const _verbose = Debug('hopr-connect:verbose')
const _error = Debug('hopr-connect:error')

type WebRTC = {
  channel: SimplePeer
  upgradeInbound: () => SimplePeer
}

export function statusMessagesCompare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  switch (a[0] as RelayPrefix) {
    case RelayPrefix.CONNECTION_STATUS:
      switch (b[0] as RelayPrefix) {
        case RelayPrefix.CONNECTION_STATUS:
          return 0
        default:
          return -1
      }
    case RelayPrefix.STATUS_MESSAGE:
      switch (b[0] as RelayPrefix) {
        case RelayPrefix.CONNECTION_STATUS:
          return 1
        case RelayPrefix.STATUS_MESSAGE:
          return 0
        default:
          return -1
      }
    case RelayPrefix.WEBRTC_SIGNALLING:
      switch (b[0] as RelayPrefix) {
        case RelayPrefix.CONNECTION_STATUS:
        case RelayPrefix.STATUS_MESSAGE:
          return 1
        case RelayPrefix.WEBRTC_SIGNALLING:
          return 0
        default:
          return -1
      }
    case RelayPrefix.PAYLOAD:
      switch (b[0] as RelayPrefix) {
        case RelayPrefix.CONNECTION_STATUS:
        case RelayPrefix.STATUS_MESSAGE:
        case RelayPrefix.WEBRTC_SIGNALLING:
          return 1
        case RelayPrefix.PAYLOAD:
          return 0
      }
  }
}

class RelayConnection extends EventEmitter implements MultiaddrConnection {
  private _stream: Stream
  private _sinkSourceAttached: boolean
  private _sinkSourceSwitched: boolean
  private _sourceSwitched: boolean
  private _streamClosed: boolean

  private statusMessages: Heap<Uint8Array>

  public _iteration: number

  private _id: string

  private _sinkSourceAttachedPromise: DeferredPromise<Stream['source']>
  private _sinkSwitchPromise: DeferredPromise<void>
  private _sourceSwitchPromise: DeferredPromise<void>
  private _migrationDone: DeferredPromise<void> | undefined
  private _destroyedPromise: DeferredPromise<void>
  private _statusMessagePromise: DeferredPromise<void>
  private _closePromise: DeferredPromise<void>

  private _onReconnect: (newStream: RelayConnection, counterparty: PeerId) => Promise<void>

  public destroyed: boolean

  public webRTC?: WebRTC

  public localAddr: Multiaddr
  public remoteAddr: Multiaddr

  private _counterparty: PeerId

  public source: Stream['source']
  public sink: Stream['sink']

  public conn: Stream

  public timeline: MultiaddrConnection['timeline']

  constructor(opts: {
    stream: Stream
    self: PeerId
    relay: PeerId
    counterparty: PeerId
    onReconnect: (newStream: RelayConnection, counterparty: PeerId) => Promise<void>
    webRTC?: WebRTC
  }) {
    super()

    this.timeline = {
      open: Date.now()
    }

    this.statusMessages = new Heap(statusMessagesCompare)

    this.destroyed = false

    this._stream = opts.stream

    this.conn = opts.stream

    this._onReconnect = opts.onReconnect

    this._counterparty = opts.counterparty

    this._id = u8aToHex(randomBytes(4), false)

    this.localAddr = new Multiaddr(`/p2p/${opts.relay.toB58String()}/p2p-circuit/p2p/${opts.self.toB58String()}`)
    this.remoteAddr = new Multiaddr(
      `/p2p/${opts.relay.toB58String()}/p2p-circuit/p2p/${opts.counterparty.toB58String()}`
    )

    this.webRTC = opts.webRTC

    this._iteration = 0

    this._sinkSourceAttached = false
    this._sinkSourceSwitched = false
    this._sourceSwitched = false
    this._streamClosed = false

    this._closePromise = Defer<void>()
    this._sinkSourceAttachedPromise = Defer<Stream['source']>()
    this._destroyedPromise = Defer<void>()
    this._statusMessagePromise = Defer<void>()
    this._sinkSwitchPromise = Defer<void>()
    this._sourceSwitchPromise = Defer<void>()

    this.source = this.createSource()

    this._stream.sink(this.sinkFunction())

    this.sink = this.attachSinkSource.bind(this)
  }

  public close(_err?: Error): Promise<void> {
    this.verbose(`close called`)

    if (this.destroyed) {
      return Promise.resolve()
    }

    this.queueStatusMessage(Uint8Array.of(RelayPrefix.CONNECTION_STATUS, ConnectionStatusMessages.STOP))

    this.setClosed()

    return this._destroyedPromise.promise
  }

  private log(..._: any[]) {
    _log(`RC [${this._id}]`, ...arguments)
  }

  private verbose(..._: any[]) {
    _verbose(`RC [${this._id}]`, ...arguments)
  }

  private error(..._: any[]) {
    _error(`RC [${this._id}]`, ...arguments)
  }

  public switch(): RelayConnection {
    if (this.webRTC != undefined) {
      try {
        this.webRTC.channel.destroy()
      } catch {}
    }

    this._migrationDone = Defer<void>()
    this._iteration++
    this._sinkSourceSwitched = true
    this._sinkSwitchPromise.resolve()
    this._sourceSwitched = true
    this._sourceSwitchPromise.resolve()

    if (this.webRTC != undefined) {
      this.webRTC.channel = this.webRTC.upgradeInbound()
    }

    this.source = this.createSource()

    return this
  }

  private setClosed() {
    this._streamClosed = true
    this._closePromise.resolve()
    this.timeline.close = Date.now()
  }

  private async attachSinkSource(_source: Stream['source']): Promise<void> {
    if (this._migrationDone != undefined) {
      await this._migrationDone.promise
    }

    this._sinkSourceAttached = true
    this._sinkSourceAttachedPromise.resolve(toU8aStream(_source))
  }

  private async *sinkFunction(this: RelayConnection): Stream['source'] {
    type SinkType = Stream['source'] | StreamResult | undefined | void

    let currentSource: Stream['source'] | undefined
    let streamPromise: Promise<StreamResult> | undefined

    let result: SinkType

    while (true) {
      let promises: Promise<SinkType>[] = []

      promises.push(this._closePromise.promise, this._sinkSwitchPromise.promise)

      if (currentSource == undefined) {
        promises.push(this._sinkSourceAttachedPromise.promise)
      }

      promises.push(this._statusMessagePromise.promise)

      if (currentSource != undefined) {
        streamPromise = streamPromise ?? currentSource.next()

        promises.push(streamPromise)
      }

      // (0. Handle source attach)
      // 1. Handle stream switch
      // 2. Handle status messages
      // 3. Handle payload messages
      result = await Promise.race(promises)

      if (this._streamClosed && this.destroyed) {
        break
      }

      if (this._sinkSourceSwitched) {
        this._sinkSourceSwitched = false
        this._sinkSwitchPromise = Defer<void>()

        // Make sure that we don't create hanging promises
        this._sinkSourceAttachedPromise.resolve()
        this._sinkSourceAttachedPromise = Defer<Stream['source']>()
        result = undefined
        currentSource = undefined
        streamPromise = undefined
        this._migrationDone?.resolve()
        continue
      }

      if (this._sinkSourceAttached) {
        this._sinkSourceAttached = false

        currentSource = result as Stream['source']

        streamPromise = undefined
        result = undefined
        continue
      }

      if (this.statusMessages.length > 0) {
        const statusMsg = this.unqueueStatusMessage()

        if (u8aEquals(statusMsg, Uint8Array.of(RelayPrefix.CONNECTION_STATUS, ConnectionStatusMessages.STOP))) {
          this.destroyed = true
          this._destroyedPromise.resolve()

          yield statusMsg
          break
        }

        yield statusMsg

        continue
      }

      const received = result as StreamResult

      if (received == undefined) {
        throw Error(`Received must not be undefined`)
      }

      if (received.done) {
        currentSource = undefined
        streamPromise = undefined
        continue
      }

      result = undefined
      streamPromise = (currentSource as Stream['source']).next()

      yield Uint8Array.from([RelayPrefix.PAYLOAD, ...received.value.slice()])
    }
  }

  private createSource() {
    let migrationDone = Defer<void>()
    const iterator = async function* (this: RelayConnection) {
      // deep-clone number
      // @TOOD make sure that the compiler does not notice
      const drainIteration = parseInt(this._iteration.toString())

      let result: StreamResult | undefined

      let streamPromise = this._stream.source.next()

      const next = () => {
        result = undefined

        streamPromise = this._stream.source.next()
      }

      if (this.webRTC != undefined) {
        this.attachWebRTCListeners(drainIteration)
      }

      while (this._iteration == drainIteration) {
        const promises = []

        promises.push(this._closePromise.promise)

        if (!this._sourceSwitched) {
          promises.push(this._sourceSwitchPromise.promise)
        }

        promises.push(streamPromise)

        result = (await Promise.race(promises)) as any

        if (this._iteration != drainIteration) {
          await migrationDone.promise
          migrationDone = Defer<void>()
          this._sourceSwitchPromise = Defer<void>()
          this._sourceSwitched = false
          break
        }

        if (result == undefined && this._sourceSwitched) {
          migrationDone.resolve()
          continue
        }

        if (this._streamClosed) {
          break
        }

        const received = result as StreamResult

        if (received.done) {
          // @TODO how to proceed ???
          break
        }

        if (received.value.length == 0) {
          next()
          this.verbose(`Ignoring empty message`)
          continue
        }

        const [PREFIX, SUFFIX] = [received.value.slice(0, 1), received.value.slice(1)]

        if (SUFFIX.length == 0) {
          next()
          this.verbose(`Ignoring empty payload`)
          continue
        }

        if (PREFIX[0] == RelayPrefix.CONNECTION_STATUS) {
          if (SUFFIX[0] == ConnectionStatusMessages.STOP) {
            this.destroyed = true
            this._destroyedPromise.resolve()
            this.setClosed()
            break
          } else if (SUFFIX[0] == ConnectionStatusMessages.RESTART) {
            this.log(`RESTART received. Ending stream ...`)
            this.emit(`restart`)

            this._onReconnect(this.switch(), this._counterparty)

            continue
          }
        } else if (PREFIX[0] == RelayPrefix.STATUS_MESSAGE) {
          if (SUFFIX[0] == StatusMessages.PING) {
            this.verbose(`PING received`)
            this.queueStatusMessage(Uint8Array.of(RelayPrefix.STATUS_MESSAGE, StatusMessages.PONG))
            // Don't forward ping to receiver
          } else if (SUFFIX[0] == StatusMessages.PONG) {
            // noop
          } else {
            this.error(`Received invalid status message ${u8aToHex(SUFFIX || new Uint8Array([]))}. Dropping message.`)
          }

          next()
          continue
        } else if (PREFIX[0] == RelayPrefix.WEBRTC_SIGNALLING) {
          let decoded: Object | undefined
          try {
            decoded = JSON.parse(new TextDecoder().decode(SUFFIX))
          } catch {
            this.error(`Error while trying to decode JSON-encoded WebRTC message`)
          }

          if (decoded != undefined) {
            try {
              this.webRTC?.channel.signal(decoded as any)
            } catch (err) {
              this.error(`WebRTC error:`, err)
            }
          }

          next()
          continue
        }

        next()
        yield SUFFIX
      }
    }.call(this)

    return eagerIterator(iterator)
  }

  /**
   * Attaches a listener to the WebRTC 'signal' events
   * and removes it once class iteration increases
   * @param drainIteration index of current iteration
   */
  private attachWebRTCListeners(drainIteration: number) {
    let currentChannel: SimplePeer
    const onSignal = (data: Object) => {
      if (this._iteration != drainIteration) {
        currentChannel.removeListener('signal', onSignal)
        return
      }

      this.queueStatusMessage(
        Uint8Array.from([RelayPrefix.WEBRTC_SIGNALLING, ...new TextEncoder().encode(JSON.stringify(data))])
      )
    }
    currentChannel = this.webRTC?.channel.on('signal', onSignal.bind(this)) as SimplePeer
  }

  /**
   * Adds a message to the message queue and notifies source
   * that a message is available
   * @param msg message to add
   */
  private queueStatusMessage(msg: Uint8Array) {
    this.statusMessages.push(msg)

    this._statusMessagePromise.resolve()
  }

  /**
   * Removes the most recent status message from the queue
   * @returns most recent status message
   */
  private unqueueStatusMessage(): Uint8Array {
    switch (this.statusMessages.length) {
      case 0:
        throw Error(`No status messages available`)
      case 1:
        this._statusMessagePromise = Defer<void>()

        return this.statusMessages.pop() as Uint8Array
      default:
        const stopMessage = Uint8Array.of(RelayPrefix.CONNECTION_STATUS, ConnectionStatusMessages.STOP)

        if (u8aEquals(this.statusMessages.top(0)[0], stopMessage)) {
          this.statusMessages.clear()
          return stopMessage
        }

        return this.statusMessages.pop() as Uint8Array
    }
  }
}

export { RelayConnection }