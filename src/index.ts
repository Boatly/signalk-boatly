/*
 * Author: Peter Sedman, Boatly Ltd
 *
 * Logs NMEA data to a SQLite database for uploading to Boatly
 */

import { combineWith } from 'baconjs'
import { Util } from './util'
import { PositionHandler } from './position_handler'
import { PassageProcessor } from './passage_processor';
import { PassageStatus, JobStatus } from './common';

const axios = require('axios').default

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
  let authToken = ''
  let dbPath = ''
  let passageProcessor: PassageProcessor

  const plugin: Plugin = {

    /************************************************************************
     *
     * Plugin Startup Code - executes when the plugin starts up or restarts
     *
     ***********************************************************************/
    start: function (props: any) {

      try {
        authToken = props.authtoken
        dbPath = getDBPath()

        // Start the passage processor queue
        passageProcessor = new PassageProcessor()

        // Start the passage processing loop
        PositionHandler.start(app, props, dbPath)

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
      const logHandler = function (req: any, res: any, next: any) {
        // Check if queued passages queued are completed and remove from passages list
        removeCompletedPassages()

        const passages = PositionHandler.getPassages()

        res.type('application/json')
        res.json(passages)
      }

      // Add the passage to the queue of passages to process
      const processHandler = function (req: any, res: any, next: any) {
        const start = req.body.start
        const end = req.body.end

        app.debug(`Queing passage ${new Date(start).toISOString()} - ${new Date(end).toISOString()}`)

        PositionHandler.setPassageStatus(start, PassageStatus.Processing)

        const path = app.getDataDirPath()
        const filename = start.replace(/\-/g, '').replace(/\:/g, '').replace(/\./g, '') + '.gpx'

        passageProcessor.queuePassage({ status: JobStatus.CreateGPX, start: start, end: end, gpxpath: `${path}/${filename}`, dbPath: dbPath, authToken: authToken,gpxfilename: filename })

        res.type('application/json')
        res.json({ status: 'Uploading' })
      }

      const discardHandler = function (req: any, res: any, next: any) {
        const start = req.body.start
        const end = req.body.end

        PositionHandler.deletePassage(start, end)

        res.type('application/json')
        res.json({ status: 'Deleted' })
      }

      // Closes off the current passage being recorded
      const finishHandler = function (req: any, res: any, next: any) {
        PositionHandler.endPassage(new Date().toISOString())
        res.type('application/json')
        res.json({ status: 'OK' })
      }

      // TODO - Read redis store to get token
      const isLoggedInHandler = function (req: any, res: any, next: any) {
        res.type('application/json')
        res.json({ loggedin: false })
      }

      // Get auth token from Boatly
      const loginHandler = function (req: any, res: any, next: any) {
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

      const statusHandler = function(req: any, res: any, next: any) {
        const result = PositionHandler.getStatus()
        res.type('application/json')
        res.json(result)
      }

      // TODO
      const downloadHandler = function(req: any, res: any, next: any) {
        // res.download()
        res.type('application/json')
        res.json({ status: 'OK' })
      }

      const deleteCompletedHandler = function(req: any, res: any, next: any) {
        PositionHandler.deleteCompletedPassages()
        res.type('application/json')
        res.json({ status: 'OK' })
      }

      const databasePathHandler = function(req: any, res: any, next: any) {
        PositionHandler.deleteCompletedPassages()
        res.type('application/json')
        res.json({ path: getDBPath() })
      }

      // Log into Boatly, returns an AuthToken used to upload and queue passages
      router.post('/self/login', loginHandler)
      router.post('/vessels/self/login', loginHandler)
      router.post(`/vessels/${app.selfId}/login`, loginHandler)

      // Determine if user has authenticated with Boatly
      router.get('/self/isloggedin', isLoggedInHandler)
      router.get('/vessels/self/isloggedin', isLoggedInHandler)
      router.get(`/vessels/${app.selfId}/isloggedin`, isLoggedInHandler)

      // Get a list of recorded passages and their status
      router.get('/self/log', logHandler)
      router.get('/vessels/self/log', logHandler)
      router.get(`/vessels/${app.selfId}/log`, logHandler)

      // Queue a recorded passage to be processed by Boatly
      router.post('/self/process', processHandler)
      router.post('/vessels/self/process', processHandler)
      router.post(`/vessels/${app.selfId}/process`, processHandler)

      // Discard a recorded passage
      router.post('/self/discard', discardHandler)
      router.post('/vessels/self/discard', discardHandler)
      router.post(`/vessels/${app.selfId}/discard`, discardHandler)

      // Close a passage, finish recording - so that it can be uploaded or discarded
      router.post('/self/finish', finishHandler)
      router.post('/vessels/self/finish', finishHandler)
      router.post(`/vessels/${app.selfId}/finish`, finishHandler)

      // Get the current status of the recorder
      router.get('/self/status', statusHandler)
      router.get('/vessels/self/status', statusHandler)
      router.get('/self/status', statusHandler)

      // Return the path of the database to which position reports are logged
      router.get('/self/databasepath', databasePathHandler)
      router.get('/vessels/self/databasepath', databasePathHandler)
      router.get('/self/databasepath', databasePathHandler)

      // Download GPX file for a passage
      router.get('/self/downloadgpx', downloadHandler)

      // Delete completed passages
      router.post('/self/deletecompleted', deleteCompletedHandler)
      router.post('/vessels/self/deletecompleted', deleteCompletedHandler)
      router.post(`/vessels/${app.selfId}/deletecompleted`, deleteCompletedHandler)

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
          title: 'Position Update Rate (seconds)',
          default: 1
        },

        movementmeters: {
          type: 'number',
          title: 'Distance (meters) vessel must move before logging position report',
          default: 10
        },

        stationarymins: {
          type: 'number',
          title: 'End the sailing passage when the vessel has been stationary for (minutes):',
          default: 10
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

  function removeCompletedPassages() {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authToken
    }

    const queuedPassages = PositionHandler.getQueuedPassages()

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

  function getDBPath(): string {
    return require('path').join(app.getDataDirPath(), 'boatly.db')
  }
}
