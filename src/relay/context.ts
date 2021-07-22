import { u8aToHex } from '@hoprnet/hopr-utils'
import { randomBytes } from 'crypto'

import Defer, { DeferredPromise } from 'p-defer'
import EventEmitter from 'events'

import type { Stream, StreamResult } from 'libp2p'

import Debug from 'debug'

const DEBUG_PREFIX = `hopr-connect`
const _log = Debug(DEBUG_PREFIX)
const _verbose = Debug(DEBUG_PREFIX.concat(`:verbose`))
const _error = Debug(DEBUG_PREFIX.concat(`:error`))

import { RelayPrefix, StatusMessages, ConnectionStatusMessages, isValidPrefix } from '../constants'
import { eagerIterator } from '../utils'

export const DEFAULT_PING_TIMEOUT = 300

/**
 * Encapsulate the relay-side state management of a relayed connecion
 */
class RelayContext extends EventEmitter {
  private _streamSourceSwitchPromise: DeferredPromise<Stream['source']>
  private _streamSinkSwitchPromise: DeferredPromise<Stream['sink']>

  private _id: string

  private _sinkSourceAttached: boolean
  private _sinkSourceAttachedPromise: DeferredPromise<Stream['source']>

  private _statusMessagePromise: DeferredPromise<void>
  private _statusMessages: Uint8Array[] = []
  private _pingResponsePromise?: DeferredPromise<void>
  private _stream: Stream

  private _sourcePromise: Promise<StreamResult> | undefined
  private _sourceSwitched: boolean

  public source: Stream['source']
  public sink: Stream['sink']

  constructor(stream: Stream) {
    super()
    this._id = u8aToHex(randomBytes(4), false)

    this._statusMessagePromise = Defer<void>()
    this._statusMessages = []
    this._stream = stream

    this._sourceSwitched = false

    this._sinkSourceAttached = false
    this._sinkSourceAttachedPromise = Defer<Stream['source']>()

    this._streamSourceSwitchPromise = Defer<Stream['source']>()
    this._streamSinkSwitchPromise = Defer<Stream['sink']>()

    this.source = this.createSource()

    this.sink = (source: Stream['source']): Promise<void> => {
      this._sinkSourceAttached = true
      this._sinkSourceAttachedPromise.resolve(source)

      return Promise.resolve()
    }

    this.createSink()
  }

  /**
   * Sends a low-level ping to the client.
   * Used to test if connection is active.
   * @param ms timeout in miliseconds
   * @returns a Promise that resolves to measured latency
   */
  public async ping(ms = DEFAULT_PING_TIMEOUT): Promise<number> {
    let start = Date.now()
    this._pingResponsePromise = Defer<void>()

    let timeoutDone = false

    const timeoutPromise = Defer<void>()
    const timeout = setTimeout(() => {
      this.log(`ping timeout done`)
      timeoutDone = true
      // Make sure that we don't produce any hanging promises
      this._pingResponsePromise?.resolve()
      this._pingResponsePromise = undefined
      timeoutPromise.resolve()
    }, ms)

    this.queueStatusMessage(StatusMessages.PING)

    await Promise.race([
      // prettier-ignore
      timeoutPromise.promise,
      this._pingResponsePromise.promise
    ])

    if (timeoutDone) {
      return -1
    }

    // Make sure that we don't produce any hanging promises
    timeoutPromise.resolve()
    clearTimeout(timeout)
    return Date.now() - start
  }

  /**
   * Attaches a new stream to an existing context
   * @param newStream the new stream to use
   */
  public update(newStream: Stream) {
    this._sourceSwitched = true

    this._streamSourceSwitchPromise.resolve(newStream.source)
    this._streamSinkSwitchPromise.resolve(newStream.sink)

    this.log(`updating`)
  }

  /**
   * Log messages and add identity tag to distinguish multiple instances
   */
  private log(..._: any[]) {
    _log(`RX [${this._id}]`, ...arguments)
  }

  /**
   * Log verbose messages and add identity tag to distinguish multiple instances
   */
  private verbose(..._: any[]) {
    _verbose(`RX [${this._id}]`, ...arguments)
  }

  /**
   * Log errors and add identity tag to distinguish multiple instances
   */
  private error(..._: any[]) {
    _error(`RX [${this._id}]`, ...arguments)
  }

  /**
   * Forwards incoming messages from current incoming stream
   * @returns an async iterator
   */
  private createSource(): Stream['source'] {
    const iterator: Stream['source'] = async function* (this: RelayContext) {
      this.log(`source called`)
      let result: Stream['source'] | StreamResult | undefined

      const next = () => {
        result = undefined
        this._sourcePromise = this._stream.source.next()
      }

      while (true) {
        const promises: Promise<Stream['source'] | StreamResult>[] = []

        // Wait for stream switches
        promises.push(this._streamSourceSwitchPromise.promise)

        // Wait for payload messages
        if (result == undefined || (result as StreamResult).done != true) {
          this._sourcePromise = this._sourcePromise ?? this._stream.source.next()

          promises.push(this._sourcePromise)
        }


        this.verbose(`FLOW: awaiting promises`)
        // 1. Handle Stream switches
        // 2. Handle payload / status messages
        result = await Promise.race(promises)
        this.verbose(`FLOW: promises done`)

        if (result == undefined) {
          // @TODO throw Error to make debugging easier
          throw Error(`source result == undefined. Should not happen.`)
        }

        // If source switched, get messages from new source
        if (this._sourceSwitched) {
          this._sourceSwitched = false
          this._stream.source = result as Stream['source']

          this._streamSourceSwitchPromise = Defer<Stream['source']>()

          next()

          this.verbose(`FLOW: source switched, continue`)
          yield Uint8Array.of(RelayPrefix.CONNECTION_STATUS, ConnectionStatusMessages.RESTART)
          continue
        }

        const received = result as IteratorYieldResult<Uint8Array>

        if (received.done) {
          this.verbose(`FLOW: received done, continue`)
          continue
        }

        // Anything can happen
        if (received.value.length == 0) {
          this.log(`got empty message`)
          next()

          this.verbose(`FLOW: got empty message, continue`)
          // Ignore empty messages
          continue
        }

        const [PREFIX, SUFFIX] = [received.value.slice(0, 1), received.value.slice(1)]

        if (!isValidPrefix(PREFIX[0])) {
          this.error(`Invalid prefix: Got <${u8aToHex(PREFIX ?? new Uint8Array())}>. Dropping message in relayContext.`)

          next()

          // Ignore invalid prefixes
          this.verbose(`FLOW: invalid prefix`)
          continue
        }

        // Interprete relay sub-protocol
        if (PREFIX[0] == RelayPrefix.STATUS_MESSAGE) {
          if (SUFFIX[0] == StatusMessages.PING) {
            this.verbose(`PING received`)
            this.queueStatusMessage(StatusMessages.PONG)
            // Don't forward ping
          } else if (SUFFIX[0] == StatusMessages.PONG) {
            this.verbose(`PONG received`)

            this._pingResponsePromise?.resolve()
            // Don't forward pong message
          }

          next()
          
          this.verbose(`FLOW: got PING or PONG, continue`)
          continue
          // Interprete connection sub-protocol
        } else if (PREFIX[0] == RelayPrefix.CONNECTION_STATUS) {
          if (SUFFIX[0] == ConnectionStatusMessages.STOP) {
            this.verbose(`STOP relayed`)

            this.emit('close')
            
            this.verbose(`FLOW: STOP relayed, break`)
            // forward STOP message
            yield received.value

            // close stream
            break
          } else if ((SUFFIX[0] = ConnectionStatusMessages.RESTART)) {
            this.verbose(`RESTART relayed`)
            this.verbose(`FLOW: RESTART relayed, break`)
          }
        }

        this.verbose(`FLOW: loop end`)

        yield received.value

        next()
      }
      
      this.verbose(`FLOW: loop ended`)
    }.call(this)

    return eagerIterator(iterator)
  }

  /**
   * Passes messages from source into current outgoing stream
   */
  private async createSink(): Promise<void> {
    this.log(`createSink called`)
    let currentSink = this._stream.sink

    let sourcePromise: Promise<StreamResult> | undefined

    let currentSource: Stream['source'] | undefined

    let iteration = 0

    async function* drain(this: RelayContext): Stream['source'] {
      // deep-clone number
      // @TODO make sure that the compiler does not notice
      const drainIteration = parseInt(iteration.toString())
      type SinkResult = Stream['source'] | StreamResult | void

      let result: SinkResult

      const next = () => {
        result = undefined

        sourcePromise = currentSource?.next()
      }

      while (iteration == drainIteration) {
        const promises: Promise<SinkResult>[] = []

        if (currentSource == undefined) {
          promises.push(this._sinkSourceAttachedPromise.promise)
        }

        promises.push(this._statusMessagePromise.promise)

        if (currentSource != undefined && (result == undefined || (result as StreamResult).done != true)) {
          sourcePromise = sourcePromise ?? currentSource.next()

          promises.push(sourcePromise)
        }

        // (0. Handle source attach)
        // 1. Handle stream switches
        // 2. Handle status messages
        // 3. Handle payload messages
        result = await Promise.race(promises)

        // Don't handle incoming messages after migration
        if (iteration != drainIteration) {
          break
        }

        if (this._sinkSourceAttached) {
          this._sinkSourceAttached = false
          currentSource = result as Stream['source']

          result = undefined
          continue
        }

        if (this._statusMessages.length > 0) {
          yield this.unqueueStatusMessage()
          continue
        }

        let received = result as StreamResult

        if (received.done) {
          continue
        }

        if (received.value.length == 0) {
          this.verbose(`Ignoring empty message`)
          next()
          continue
        }

        let [PREFIX, SUFFIX] = [received.value.slice(0, 1), received.value.slice(1)]

        if (SUFFIX.length == 0) {
          this.verbose(`Ignoring empty payload`)
          next()
          continue
        }

        if (PREFIX[0] == RelayPrefix.CONNECTION_STATUS && SUFFIX[0] == ConnectionStatusMessages.STOP) {
          yield received.value
          break
        }

        next()
        yield received.value
      }
    }

    while (true) {
      currentSink(drain.call(this))

      currentSink = await this._streamSinkSwitchPromise.promise
      iteration++
      this._streamSinkSwitchPromise = Defer<Stream['sink']>()
    }
  }

  /**
   * Add status and control messages to queue
   * @param msg msg to add
   */
  private queueStatusMessage(msg: StatusMessages) {
    this._statusMessages.push(Uint8Array.of(RelayPrefix.STATUS_MESSAGE, msg))

    this._statusMessagePromise.resolve()
  }

  /**
   * Removes latest message from queue and returns it.
   * Resets the waiting mutex if queue is empty.
   * @returns latest status or control message
   */
  private unqueueStatusMessage(): Uint8Array {
    switch (this._statusMessages.length) {
      case 0:
        throw Error(`Trying to unqueue empty status message queue`)
      case 1:
        this._statusMessagePromise = Defer<void>()
        return this._statusMessages.pop() as Uint8Array
      default:
        return this._statusMessages.shift() as Uint8Array
    }
  }
}

export { RelayContext }
