import { Util } from './util'
import {Database} from './database'

// Used to determine if the boating is moving or stationary
let underway = false
let lastPositionReport: any

// Details of current passage being recorded
let passageStartTime: any = null

interface IStatus {
  status: 'WAITING_INITIAL_POSITION' | 'READY' | 'RECORDING' | 'STOPPED',
  description: string,
  prs:  number,
  stoppedmins: number
}

let status: IStatus

export module PositionHandler {

  let app: any
  let props: any
  let movementmeters = 10
  let stationarymins = 10
  let database: Database

  export function start(_app: any, _props: any, dbPath: string) {
    app = _app
    props = _props

    props.movementmeters ? movementmeters = props.movementmeters : movementmeters = 10
    props.stationarymins ? stationarymins = props.stationarymins : stationarymins = 10

    app.setProviderStatus('Starting up...');

    app.debug('**** STARTING UP ****')

    database = new Database(dbPath)

    // On startup reload passage start time and last position report
    passageStartTime = database.getPassageStart()

    if (passageStartTime) {
      app.debug(`Existing passage found: ${passageStartTime}`)
      lastPositionReport = getLastPR()
      app.debug(`Last position report loaded: ${JSON.stringify(lastPositionReport)}`)
      setStatus('READY')
    } else {
      setStatus('WAITING_INITIAL_POSITION')
    }

  }

  // Called when plugin is stopped
  export function stop() {
    database.close()
  }

  export function getStatus(): IStatus {
    return status
  }

  function setStatus(value: 'WAITING_INITIAL_POSITION' | 'READY' | 'RECORDING' | 'STOPPED', stoppedMins?: number) {
    let desc = ''
    let prs= 0

    if (value === 'WAITING_INITIAL_POSITION') {
      desc = 'Waiting for initial position report'
    } else if (value === 'READY') {
      desc = 'Ready - Waiting for vessel to move'
    } else if (value === 'RECORDING') {
      desc = 'Vessel is moving and sailing passage is being recorded.'
      prs = database.getPositionReportCount(passageStartTime)
    } else if (value === 'STOPPED') {
      desc = 'Vessel is stopped, recording will continue until vessel has been stationary for '
      prs = database.getPositionReportCount(passageStartTime)
    }

    status = {status: value, description: desc, prs: prs, stoppedmins: stoppedMins}

    app.setProviderStatus(desc)
  }

  export function onPositionReport(pr: any) {
    // Ignore if HDOP > 5 or no position available
    if ((pr.lat === undefined || pr.lon === undefined || pr.sog === undefined) || (pr.hdop !== undefined && pr.hdop > 5)) {

      if (pr.lat === undefined) {
        app.debug('Ignoring Position Report : No Latitude')
      } else if (pr.lon === undefined) {
        app.debug('Ignoring Position Report : No Longitude')
      } else if (pr.sog === undefined) {
        app.debug('Ignoring Position Report : No SOG')
      } else if (pr.hdop !== undefined && pr.hdop > 5) {
        app.debug('Ignoring Position Report : HDOP > 5')
      }

      return
    }

    let distanceMoved = 0

    // Calculate the distance moved between this pr and the last pr
    if (lastPositionReport) {
      distanceMoved = Util.distanceBetweenCoordinates(lastPositionReport.lat, lastPositionReport.lon, pr.lat, pr.lon)
    }

    // Determine if we are underway:
    // If vessel moved >= 10 m since last position report
    if (!underway) {
      if (distanceMoved >= movementmeters) {
        // The vessel has started moving if this is the first PR received since initial PR
        setStatus('RECORDING')
        app.debug(`Movement detected - started recording at ${new Date(pr.time).toISOString()}`)
        underway = true
      } else if (!lastPositionReport) {
        // Latch in first position report which is the base reference for the start of the passage
        setStatus('READY')
        app.debug(`Initial Position Determined: ${pr.lat, pr.lon}`)
        lastPositionReport = pr
        return
      } else {
        // Vessel still stopped at the same position - wait until it moves
        app.debug(`Not yet underway.  Vessel has moved: ${distanceMoved}`)
        return
      }
    }

    /*******************************************
       Handle the logging of position reports
       Only log PRs when boat moves
    ********************************************/

    // Only write to the database if the boat has moved >= 10m since the last position report or this is the first position report
    if (distanceMoved >= movementmeters) {
      // Vessel has moved since last position report
      database.writePositionReportToDB(pr)
      lastPositionReport = pr

      setStatus('RECORDING')

      // app.debug(`Position report logged: ${pr.time}`)
    }

    // Continue processing even if vessel hasn't moved as need to check if this is then end of the passage.
    // This occurs when the vessel is in the same position from >= 15 mins

    /*******************************************
       Handle passage start and end
    ********************************************/

    // Set passage start end times

    if (!passageStartTime) {
      // This is the start of a new passage - set the start time and log to database
      app.debug(`** New Passage Started : ${pr.time} **`)

      passageStartTime = pr.time

      // Create new passage record in database
      database.createPassage(pr.time)
    }

    // Check if vessel has been stationary for >= 15 min ... this is end of passage
    if (distanceMoved < movementmeters) {
      const elapsedMins = (pr.time.valueOf() - lastPositionReport.time.valueOf()) / 60000

      // Change the vessels status if stopped for >= 15 seconds
      if (elapsedMins >= 0.25) {
        app.debug(`** Stopped for: ${elapsedMins} minutes`)
        setStatus('STOPPED', elapsedMins)
      }

      if (elapsedMins >= stationarymins) {
        app.debug(`** END OF PASSAGE DETECTED **`)

        // Write to database to close passage
        endPassage(pr.time.valueOf())
      }
    }

  }

  export function endPassage(time: number) {
    database.closePassageRecord(passageStartTime, time)

    passageStartTime = null
    lastPositionReport = null
    underway = false
    setStatus('WAITING_INITIAL_POSITION')
  }

  function getLastPR() {
    return database.getLastPR()
  }

  // Get a list of passages
  export function getPassages() {
    return database.getPassages()
  }

  export function getQueuedPassages() {
    return database.getQueuedPassages()
  }

  export function setPassageStatus(time: any, status: 'creategpx' | 'getpsurl' | 'uploads3' | 'queue' | 'creategpx - failed' | 'getpsurl - failed' | 'uploads3 - failed' | 'queue - failed') {
    database.setPassageStatus(time, status)
  }

  export function deletePassage(start: any, end: any) {
    database.deletePassage(start, end)
  }

}
