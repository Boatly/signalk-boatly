/*
 * Author: Peter Sedman, Boatly Ltd
 *
 * Logs NMEA data to a SQLite database for uploading to Boatly
 */

import { combineWith } from 'baconjs'
import { Util } from './util'
import { PositionHandler } from './position_handler'

const axios = require('axios').default
var Queue = require('bull');

var jobQueue = new Queue('boatly', 'redis://127.0.0.1:6379');

interface Plugin {
  start: (app: any) => void,
  started: boolean,
  stop: () => void,
  statusMessage: (msg: string) => void,
  signalKApiRoutes: (router: any) => void,
  id: string,
  name: string,
  description: string,
  schema: any
}

export default function (app: any) {
  const error = app.error || ((msg: string) => { console.error(msg) })
  const debug = app.debug || ((msg: string) => { console.log(msg) })

  const baseurl = 'https://boatly-api.herokuapp.com/v1'

  let unsubscribe: () => void
  let lastMessages: [string, string, string] = ['', '', '']
  let authToken = ''

  const plugin: Plugin = {

    /************************************************************************
     *
     * Plugin Startup Code - executes when the plugin starts up or restarts
     *
     ***********************************************************************/
    start: async function (props: any) {

      try {
        authToken = props.authtoken

        // Start the passage processing loop
        await PositionHandler.start(app, props)

        // Subscribe to position reports - receive every 1 second by default
        // Subscribe to each delta required and combine them into a single position report
        unsubscribe = combineWith<any, any>(function (position: Position, sog: number, cog: number, tws: number, twa: number, twd: number, hdop: number) {
          return createPositionReportMessage(position, sog, cog, tws, twa, twd, hdop)
        }, [
          'navigation.position',
          'navigation.speedOverGround',
          'navigation.courseOverGroundTrue',
          'environment.wind.speedOverGround', // TWS
          'environment.wind.angleTrueGround', // TWA
          'environment.wind.directionTrue', // TWD
          'navigation.gnss.horizontalDilution'
        ]
          .map(app.streambundle.getSelfStream, app.streambundle) // Get the delta stream for own vessel
          .map((s: any) => s.toProperty(undefined))) // Map all values to undefined initially
          .changes() // Detect when a property changes
          .debounceImmediate((props.updaterate || 1) * 1000) // Only receive changes as specified by 'updaterate' config
          .onValue((positionReport: any) => {
            // Position report messages are returned here
            PositionHandler.onPositionReport(positionReport)
          })

      } catch (e) {
        plugin.started = false
        app.debug(e)
      }
    },

    // Unsubcribe from deltas when the plugin is stopped
    stop: function () {
      PositionHandler.stop()

      if (unsubscribe) {
        unsubscribe()
      }
    },

    statusMessage: function () {
      return `Started`
    },

    signalKApiRoutes: function (router) {

      // Return a list of passages that need processing
      const logHandler = async function (req: any, res: any, next: any) {
        // Check if queued passages queued are completed and remove from passages list
        removeCompletedPassages()

        const passages = await PositionHandler.getPassages()

        res.type('application/json')
        res.json(passages)
      }

      // Add the passage to the queue of passages to process
      const processHandler = async function (req: any, res: any, next: any) {
        const start = req.body.start
        const end = req.body.end

        app.debug(`Queing passage ${new Date(start).toISOString()} - ${new Date(end).toISOString()}`)

        await PositionHandler.setPassageStatus(start, 'Uploading')

        jobQueue.add({ start: start, end: end, path: app.getDataDirPath() })

        res.type('application/json')
        res.json({ status: 'Uploading' })
      }

      const discardHandler = async function (req: any, res: any, next: any) {
        const start = req.body.start
        const end = req.body.end

        await PositionHandler.deletePassage(start, end)

        res.type('application/json')
        res.json({ status: 'Deleted' })
      }

      // Closes off the current passage being recorded
      const finishHandler = async function (req: any, res: any, next: any) {
        PositionHandler.endPassage(Date.now().valueOf())

        res.type('application/json')
        res.json({ status: 'Completed' })
      }

      // TODO - Read redis store to get token
      const isLoggedInHandler = async function (req: any, res: any, next: any) {
        res.type('application/json')
        res.json({ loggedin: false })
      }

      // Get auth token from Boatly
      const loginHandler = async function (req: any, res: any, next: any) {
        axios.post(`${baseurl}/authenticate`, req)
          .then((response: any) => {
            app.debug(`JWT: ${req.JWT}`)
            app.debug(`User ID: ${req.user.user_id}`)

            // TODO - store token and user id in Redis so that worker process can read it
            res.type('application/json')
            res.json({ status: 'OK' })
          })
          .catch((error: any) => {
            app.debug('Login failed')
            res.type('application/json')
            res.json({ status: 'Failed' })
          })
      }

      // Log into Boatly, returns an AuthToken used to upload and queue passages
      router.post('/self/login', loginHandler)
      router.post('/vessels/self/login', loginHandler)
      router.post('/vessels/' + app.selfId + '/login', loginHandler)

      // Determine if user has authenticated with Boatly
      router.get('/self/isloggedin', isLoggedInHandler)
      router.get('/vessels/self/isloggedin', isLoggedInHandler)
      router.get('/vessels/' + app.selfId + '/isloggedin', isLoggedInHandler)

      // Get a list of recorded passages and their status
      router.get('/self/log', logHandler)
      router.get('/vessels/self/log', logHandler)
      router.get('/vessels/' + app.selfId + '/log', logHandler)

      // Queue a recorded passage to be processed by Boatly
      router.post('/self/process', processHandler)
      router.post('/vessels/self/process', processHandler)
      router.post('/vessels/' + app.selfId + '/process', processHandler)

      // Discard a recorded passage
      router.post('/self/discard', discardHandler)
      router.post('/vessels/self/discard', discardHandler)
      router.post('/vessels/' + app.selfId + '/discard', discardHandler)

      // Close a passage, finish recording - so that it can be uploaded or discarded
      router.post('/self/finish', finishHandler)
      router.post('/vessels/self/finish', finishHandler)
      router.post('/vessels/' + app.selfId + '/finish', finishHandler)

      return router
    },


    started: false,
    id: 'signalk-boatly',
    name: 'SignalK Boatly Plugin',
    description: 'A plugin that records sailing passages and uploads them to Boatly - https://wwww.boatly.com',
    schema: {
      type: 'object',
      properties: {
        updaterate: {
          type: 'number',
          title: 'Position Update Rate (s)',
          default: 1
        },
        authtoken: {
          type: 'string',
          title: 'Auth Token',
          default: ''
        }
      }
    }
  }

  return plugin

  async function removeCompletedPassages() {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authToken
    }

    const queuedPassages = await PositionHandler.getQueuedPassages()

    queuedPassages.forEach((passage: any) => {
      // Check if the passage exists in boatly
      axios.get(`${baseurl}/passages/pollimport/${passage.passageid}`, { headers: headers })
        .then((response: any) => {
          PositionHandler.deletePassage(passage.start, passage.end)
        })
        .catch((error: any) => {
          app.debug(`Passage not completed: ${passage.passageid}`)
        })
    });
  }

  function createPositionReportMessage(position: any, sog: number, cog: number, tws: number, twa: number, twd: number, hdop: number) {
    return {
      time: new Date().getTime(), // TODO use timestamp of incoming position
      lat: position !== undefined ? position.latitude : undefined,
      lon: position !== undefined ? position.longitude : undefined,
      sog: sog !== undefined ? Util.mpsToKn(sog) : undefined,
      cog: cog !== undefined ? Util.radsToDeg(cog) : undefined,
      tws: tws !== undefined ? Util.mpsToKn(tws) : undefined,
      twa: twa !== undefined ? Util.radsToDeg(twa) : undefined,
      twd: twd !== undefined ? Util.radsToDeg(twd) : undefined,
      hdop: hdop !== undefined ? hdop : undefined,
    }
  }

  function sendLivePositionUpdate(pr: any) {

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authToken
    }

    const data = {
      datetime: new Date().toISOString(),
      latitude: pr.lat,
      longitude: pr.lon,
      cog: pr.cog,
      speed: pr.sog,
      message: '',
    }

    axios.post('https://localhost:4567/v1/tracking', data, { headers: headers })
      .then((response: any) => {
        app.debug(response.statusMessage)
      })
      .catch((error: any) => {
        app.debug(error)
      })
  }
}
