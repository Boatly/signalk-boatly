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
import { Database } from './database';
import { stringify } from 'flatted';

const axios = require('axios').default
const fs = require('fs');

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
  // const error = app.error || ((msg: string) => { console.error(msg) })
  // const debug = app.debug || ((msg: string) => { console.log(msg) })

  const baseurl = 'https://boatly-api.herokuapp.com/v1'

  let unsubscribe: () => void
  let authToken = null
  let userID = null
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
        dbPath = getDBPath()

        // Login to Boatly to get AuthToken and User ID
        loginBoatly(props.authentication.email, props.authentication.password)

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

        // Exit if user is not authenticated
        if (!authToken || !userID) {
          res.type('application/json')
          res.json({ status: 'completed' })
        } else {
          // Queue the passage for processing
          const start = req.body.start
          const end = req.body.end

          app.debug(`Queing passage ${new Date(start).toISOString()} - ${new Date(end).toISOString()}`)

          PositionHandler.setPassageStatus(start, PassageStatus.Processing)

          const filename = startToGPXFilename(start)

          passageProcessor.queuePassage({
            status: JobStatus.CreateGPX,
            start: start, end: end,
            dbPath: dbPath,
            authToken: authToken,
            userID: userID,
            gpxFilename: filename
          })

          res.type('application/json')
          res.json({ status: 'processing' })
        }
      }

      const discardHandler = function (req: any, res: any, next: any) {
        const start = req.body.start
        const end = req.body.end

        // Delete the passage from the database
        PositionHandler.deletePassage(start, end)

        // Delete the GPX file
        const filename = startToGPXFilename(start)
        if (fs.existsSync(filename)) {
          fs.unlinkSync(filename)
        }

        res.type('application/json')
        res.json({ status: 'Deleted' })
      }

      // Closes off the current passage being recorded
      const finishHandler = function (req: any, res: any, next: any) {
        PositionHandler.endPassage(new Date().toISOString())
        res.type('application/json')
        res.json({ status: 'OK' })
      }

      const isLoggedInHandler = function (req: any, res: any, next: any) {
        res.type('application/json')
        res.json({ loggedin: isLoggedIn() })
      }

      const statusHandler = function (req: any, res: any, next: any) {
        const status = PositionHandler.getStatus()
        const result = { loggedin: isLoggedIn(), status: status }
        res.type('application/json')
        res.json(result)
      }

      // Download the GPX file for a passage
      const downloadHandler = async function (req: any, res: any, next: any) {
        const gpxFile = startToGPXFilename(req.query.start)

        if (!fs.existsSync(gpxFile)) {
          await exportToGPX(gpxFile, req.query.start, req.query.end)
        }

        res.download(gpxFile)
      }

      const deleteCompletedHandler = function (req: any, res: any, next: any) {
        PositionHandler.deleteCompletedPassages()
        res.type('application/json')
        res.json({ status: 'OK' })
      }

      const databasePathHandler = function (req: any, res: any, next: any) {
        PositionHandler.deleteCompletedPassages()
        res.type('application/json')
        res.json({ path: getDBPath() })
      }

      // Determine if user has authenticated with Boatly
      router.get('/self/signalkboatly/isloggedin', isLoggedInHandler)
      router.get('/vessels/self/signalkboatly/isloggedin', isLoggedInHandler)
      router.get(`/vessels/${app.selfId}/signalkboatly/isloggedin`, isLoggedInHandler)

      // Get a list of recorded passages and their status
      router.get('/self/signalkboatly/log', logHandler)
      router.get('/vessels/self/signalkboatly/log', logHandler)
      router.get(`/vessels/${app.selfId}/signalkboatly/log`, logHandler)

      // Queue a recorded passage to be processed by Boatly
      router.post('/self/signalkboatly/process', processHandler)
      router.post('/vessels/self/signalkboatly/process', processHandler)
      router.post(`/vessels/${app.selfId}/signalkboatly/process`, processHandler)

      // Discard a recorded passage
      router.post('/self/signalkboatly/discard', discardHandler)
      router.post('/vessels/self/signalkboatly/discard', discardHandler)
      router.post(`/vessels/${app.selfId}/signalkboatly/discard`, discardHandler)

      // Close a passage, finish recording - so that it can be uploaded or discarded
      router.post('/self/signalkboatly/finish', finishHandler)
      router.post('/vessels/self/signalkboatly/finish', finishHandler)
      router.post(`/vessels/${app.selfId}/signalkboatly/finish`, finishHandler)

      // Get the current status of the recorder
      router.get('/self/signalkboatly/status', statusHandler)
      router.get('/vessels/self/signalkboatly/status', statusHandler)
      router.get(`/vessels/${app.selfId}/signalkboatly/status`, statusHandler)

      // Return the path of the database to which position reports are logged
      router.get('/self/signalkboatly/databasepath', databasePathHandler)
      router.get('/vessels/self/signalkboatly/databasepath', databasePathHandler)
      router.get(`/vessels/${app.selfId}/signalkboatly/databasepath`, databasePathHandler)

      // Download GPX file for a passage
      router.get('/self/signalkboatly/downloadgpx', downloadHandler)
      router.get('/vessels/self/signalkboatly/downloadgpx', downloadHandler)
      router.get(`/vessels/${app.selfId}/signalkboatly/downloadgpx`, downloadHandler)

      // Delete completed passages
      router.post('/self/signalkboatly/deletecompleted', deleteCompletedHandler)
      router.post('/vessels/self/signalkboatly/deletecompleted', deleteCompletedHandler)
      router.post(`/vessels/${app.selfId}/signalkboatly/deletecompleted`, deleteCompletedHandler)

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
          title: 'Recording rate (seconds)',
          default: 10
        },

        movementmeters: {
          type: 'number',
          title: 'Distance (meters) vessel must move before recording a position report',
          default: 10
        },

        stationarymins: {
          type: 'number',
          title: 'End the sailing passage when the vessel has been stationary for (minutes):',
          default: 10
        },

        authentication: {
          type: "object",
          title: "Boatly Login",
          properties: {
            email: {
              type: 'string',
              title: 'Email',
              default: ''
            },
            password: {
              type: 'string',
              title: 'Password',
              default: ''
            },
          }
        }
      }
    }
  }

  return plugin

  function loginBoatly(email: string, password: string) {
    authToken = null
    userID = null

    const payload = {
      email: email,
      password: password
    }

    const options = {
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (email.length > 0 && password.length > 0) {
      axios.post(`${baseurl}/authenticate`, payload, options)
        .then((response: any) => {
          authToken = response.data.JWT
          userID = response.data.user.user_id
        })
        .catch((error: any) => {
          app.debug(stringify(error))
          app.debug('Login failed')
        })
    }
  }

  function isLoggedIn(): boolean {
    if (!authToken || !userID) return false
    return (authToken.length > 0 && userID.length > 0)
  }

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
      time: new Date().getTime(),
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

  function startToGPXFilename(start: string): string {
    return app.getDataDirPath() + '/' + start.replace(/\-/g, '').replace(/\:/g, '').replace(/\./g, '') + '.gpx'
  }

  function exportToGPX(filename: string, start: string, end: string) {
    // Retrieve the passage PRs from the database
    let prs = new Database(dbPath).getPassagePRs(start, end)

    // Write to the GPX file
    fs.appendFileSync(filename, `<?xml version='1.0'?><gpx version='1.0'><trk><trkseg>`)

    // Create a GPX file and write each row to it
    prs.forEach(async (row) => {
      let trckpt = `<trkpt lat='${row.lat}' lon='${row.lon}'><time>${row.time}</time><cog>${row.cog}</cog><sog>${row.sog}</sog>`

      if (row.tws) {
        trckpt += `<tws>${row.tws}</tws>`
      }

      if (row.twa) {
        trckpt += `<twa>${row.twa}</twa>`
      }

      if (row.twd) {
        trckpt += `<twd>${row.tws}</twd>`
      }

      trckpt += `</trkpt>`

      fs.appendFileSync(filename, trckpt)
    });

    fs.appendFileSync(filename, `</trkseg></trk></gpx>`)
  }
}
