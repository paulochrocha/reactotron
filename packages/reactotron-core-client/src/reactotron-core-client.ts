import * as WebSocket from "ws"
import validate from "./validate"
import logger from "./plugins/logger"
import image from "./plugins/image"
import benchmark from "./plugins/benchmark"
import stateResponses from "./plugins/state-responses"
import apiResponse from "./plugins/api-response"
import clear from "./plugins/clear"
import serialize from "./serialize"
import { start } from "./stopwatch"
import { ClientOptions } from "./client-options"

export const corePlugins = [
  image(),
  logger(),
  benchmark(),
  stateResponses(),
  apiResponse(),
  clear(),
]

const DEFAULT_OPTIONS: ClientOptions = {
  createSocket: null,
  host: "localhost",
  port: 9090,
  name: "reactotron-core-client",
  secure: false,
  plugins: corePlugins,
  safeRecursion: true,
  onCommand: command => null,
  onConnect: () => null,
  onDisconnect: () => null,
}

// these are not for you.
const reservedFeatures = [
  "options",
  "connected",
  "socket",
  "plugins",
  "configure",
  "connect",
  "send",
  "use",
  "startTimer",
]
const isReservedFeature = (value: string) => reservedFeatures.some(res => res === value)

export class Client {
  // the configuration options
  options: ClientOptions = Object.assign({}, DEFAULT_OPTIONS)

  /**
   * Are we connected to a server?
   */
  connected = false

  /**
   * The socket we're using.
   */
  socket: WebSocket = null

  /**
   * Available plugins.
   */
  plugins: any[] = []

  /**
   * Messages that need to be sent.
   */
  sendQueue: any[] = []

  /**
   * Are we ready to start communicating?
   */
  isReady = false

  /**
   * The last time we sent a message.
   */
  lastMessageDate = new Date()

  /**
   * Starts a timer and returns a function you can call to stop it and return the elapsed time.
   */
  startTimer = () => start()

  /**
   * Set the configuration options.
   */
  configure(options: ClientOptions = {}): Client {
    // options get merged & validated before getting set
    const newOptions = Object.assign({}, this.options, options)
    validate(newOptions)
    this.options = newOptions

    // if we have plugins, let's add them here
    if (Array.isArray(this.options.plugins)) {
      this.options.plugins.forEach(p => this.use(p))
    }

    return this
  }

  /**
   * Connect to the Reactotron server.
   */
  connect(): Client {
    this.connected = true
    const {
      createSocket,
      secure,
      host,
      port,
      name,
      userAgent,
      environment,
      reactotronVersion,
    } = this.options
    const { onCommand, onConnect, onDisconnect } = this.options

    // establish a connection to the server
    const protocol = secure ? "wss" : "ws"
    const socket = createSocket(`${protocol}://${host}:${port}`)

    // fires when we talk to the server
    const onOpen = () => {
      // fire our optional onConnect handler
      onConnect && onConnect()

      // trigger our plugins onConnect
      this.plugins.forEach(p => p.onConnect && p.onConnect())
      this.isReady = true
      // introduce ourselves
      this.send("client.intro", { host, port, name, userAgent, reactotronVersion, environment })

      // flush the send queue
      while (this.sendQueue.length > 0) {
        const h = this.sendQueue[0]
        this.sendQueue = this.sendQueue.slice(1)
        this.socket.send(h)
      }
    }

    // fires when we disconnect
    const onClose = () => {
      this.isReady = false
      // trigger our disconnect handler
      onDisconnect && onDisconnect()

      // as well as the plugin's onDisconnect
      this.plugins.forEach(p => p.onDisconnect && p.onDisconnect())
    }

    // fires when we receive a command, just forward it off
    const onMessage = (data: any) => {
      const command = JSON.parse(data)
      // trigger our own command handler
      onCommand && onCommand(command)

      // trigger our plugins onCommand
      this.plugins.forEach(p => p.onCommand && p.onCommand(command))
    }

    // this is ws style from require('ws') on node js
    if (socket.on) {
      socket.on("open", onOpen)
      socket.on("close", onClose)
      socket.on("message", onMessage)
    } else {
      // this is a browser
      socket.onopen = onOpen
      socket.onclose = onClose
      socket.onmessage = evt => onMessage(evt.data)
    }

    // assign the socket to the instance
    this.socket = socket

    return this
  }

  /**
   * Sends a command to the server
   */
  send = (type, payload = {}, important = false) => {
    // jet if we don't have a socket
    if (!this.socket) {
      return
    }

    // set the timing info
    const date = new Date()
    let deltaTime = date.getTime() - this.lastMessageDate.getTime()
    // glitches in the matrix
    if (deltaTime < 0) {
      deltaTime = 0
    }
    this.lastMessageDate = date

    const fullMessage = {
      type,
      payload,
      important: !!important,
      date: date.toISOString(),
      deltaTime,
    }

    const serializedMessage = serialize(fullMessage)

    if (this.isReady) {
      // send this command
      this.socket.send(serializedMessage)
    } else {
      // queue it up until we can connect
      this.sendQueue.push(serializedMessage)
    }
  }

  /**
   * Sends a custom command to the server to displays nicely.
   */
  display(config: any = {}) {
    const { name, value, preview, image: img, important = false } = config
    const payload = {
      name,
      value: value || null,
      preview: preview || null,
      image: img || null,
    }
    this.send("display", payload, important)
  }

  /**
   * Client libraries can hijack this to report errors.
   */
  reportError(this: any, error) {
    this.error(error)
  }

  /**
   * Adds a plugin to the system
   */
  use(pluginCreator?: (client: Client) => any): Client {
    // we're supposed to be given a function
    if (typeof pluginCreator !== "function") {
      throw new Error("plugins must be a function")
    }

    // execute it immediately passing the send function
    const plugin = pluginCreator.bind(this)(this)

    // ensure we get an Object-like creature back
    if (typeof plugin !== "object") {
      throw new Error("plugins must return an object")
    }

    // do we have features to mixin?
    if (plugin.features) {
      // validate
      if (typeof plugin.features !== "object") {
        throw new Error("features must be an object")
      }

      // here's how we're going to inject these in
      const inject = (key: string) => {
        // grab the function
        const featureFunction = plugin.features[key]

        // only functions may pass
        if (typeof featureFunction !== "function") {
          throw new Error(`feature ${key} is not a function`)
        }

        // ditch reserved names
        if (isReservedFeature(key)) {
          throw new Error(`feature ${key} is a reserved name`)
        }

        // ok, let's glue it up... and lose all respect from elite JS champions.
        this[key] = featureFunction
      }

      // let's inject
      Object.keys(plugin.features).forEach(key => inject(key))
    }

    // add it to the list
    this.plugins.push(plugin)

    // call the plugins onPlugin
    plugin.onPlugin && typeof plugin.onPlugin === "function" && plugin.onPlugin.bind(this)(this)

    // chain-friendly
    return this
  }
}

// convenience factory function
export const createClient = (options?: ClientOptions) => {
  const client = new Client()
  client.configure(options)
  return client
}
