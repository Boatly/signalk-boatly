import { Util } from './util'
import { debug } from 'util'
const sqlite = require("better-sqlite3")
const MINUTES_STOPPED_END_PASSAGE = 15

// Used to determine if the boating is moving or stationary
let underway = false
let lastPositionReport: any

// Details of current passage being recorded
let passageStartTime: any = null

interface PositionReport {
  time: number,
  lon: number | undefined,
  lat: number | undefined,
  sog: number | undefined,
  cog: number | undefined,
  tws: number | undefined,
  twa: number | undefined,
  twd: number | undefined,
}

export module PositionHandler {

  let app: any
  let db: any
  let status = ''

  export function start(_app: any, props: any) {
    app = _app

    app.setProviderStatus('Start Up');

    app.debug('**** STARTING UP ****')

    // Create the database
    createDatabase()

    // On startup reload passage start time and last position report
    passageStartTime = getPassageStart()

    if (passageStartTime) {
      app.debug(`Existing passage found: ${passageStartTime}`)
      lastPositionReport = getLastPR()
      app.debug(`Last position report loaded: ${JSON.stringify(lastPositionReport)}`)
    }

    app.setProviderStatus('Started & waiting for position reports');
  }

  // Called when plugin is stopped
  export function stop() {
    db.close()

    // app.debug('** Database Closed **')
  }

  export function getStatus(): string {
    return this.status
  }

  export function onPositionReport(pr: any) {
    // Ignore if HDOP > 5 or no position available
    if ((pr.lat === undefined || pr.lon === undefined || pr.sog === undefined) || (pr.hdop !== undefined && pr.hdop > 5)) {

      if (pr.lat === undefined) {
        app.setProviderStatus('Ignoring Position Report : No Latitude')
        app.debug('Ignoring Position Report : No Latitude')
      } else if (pr.lon === undefined) {
        app.setProviderStatus('Ignoring Position Report : No Longitude')
        app.debug('Ignoring Position Report : No Longitude')
      } else if (pr.sog === undefined) {
        app.setProviderStatus('Ignoring Position Report : No SOG')
        app.debug('Ignoring Position Report : No SOG')
      } else if (pr.hdop !== undefined && pr.hdop > 5) {
        app.setProviderStatus('Ignoring Position Report : HDOP > 5')
        app.debug('Ignoring Position Report : HDOP > 5')
      }

      return
    }

    let distanceMoved = 0

    // Calculate the distance between this pr and the last pr
    if (lastPositionReport) {
      distanceMoved = Util.distanceBetweenCoordinates(lastPositionReport.lat, lastPositionReport.lon, pr.lat, pr.lon)
    }

    // Determine if we are underway:
    // If vessel moved >= 10 m since last position report
    if (!underway) {
      if (distanceMoved >= 10) {
        this.status = 'Movement detected - recording'
        app.setProviderStatus(`Movement detected - started recording at ${new Date(pr.time).toISOString()}`)
        app.debug(`Movement detected - started recording at ${new Date(pr.time).toISOString()}`)
        underway = true
      } else if (!lastPositionReport) {
        // Latch in first position report which is the base reference for the start of the passage
        this.status = 'Initial position determined - waiting for vessel to move'
        app.setProviderStatus(`Initial Position Determined: ${pr.lat, pr.lon}`)
        app.debug(`Initial Position Determined: ${pr.lat, pr.lon}`)
        lastPositionReport = pr
        return
      } else {
        // Vessel still stopped at the same position - wait until it moves
        app.debug(`Vessel moved: ${distanceMoved}`)
        return
      }
    }

    /*******************************************
       Handle the logging of position reports
       Only log PRs when boat moves
    ********************************************/

    // Only write to the database if the boat has moved >= 10m since the last position report or this is the first position report
    if (distanceMoved >= 10) {
      // Vessel has moved since last position report
      writePositionReportToDB(pr)
      lastPositionReport = pr
      app.debug(`Position report logged: ${pr.time}`)
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
      createPassage(pr.time)
    }

    // Check if vessel has been stationary for >= 15 min ... this is end of passage
    if (distanceMoved < 10) {
      const elapsedMins = (pr.time.valueOf() - lastPositionReport.time.valueOf()) / 60000

      app.debug(`** Stopped for: ${elapsedMins} minutes`)

      if (elapsedMins >= 1) {
        this.status = 'Vessel stopped'
        app.setProviderStatus(`Stopped for: ${Math.round(elapsedMins * 100) / 100} minutes`)
      }

      if (elapsedMins >= MINUTES_STOPPED_END_PASSAGE) {
        app.setProviderStatus(`End of passage detected`)
        app.debug(`*** END OF PASSAGE DETECTED ***`)

        // Write to database to close passage
        endPassage(pr.time.valueOf())
      }
    } else {
      this.status = 'Movement detected - recording'
    }

  }

  export function endPassage(time: number) {
    closePassageRecord(passageStartTime, time)

    passageStartTime = null
    lastPositionReport = null
    underway = false
  }

  // Create SQLite Database if it doesn't exist
  function createDatabase() {
    const dbFile = require('path').join(app.getDataDirPath(), 'boatly.db')
    db = new sqlite(dbFile)
    db.prepare("CREATE TABLE IF NOT EXISTS positionreports (time TEXT, lat REAL, lon REAL, sog REAL, cog INTEGER, tws REAL, twa INTEGER, twd INTEGER)").run()
    db.prepare("CREATE TABLE IF NOT EXISTS passages (start TEXT, end TEXT, status TEXT)").run()

    app.debug(`** Database path: ${dbFile}`)
  }

  // Write position report to the DB
  function writePositionReportToDB(report: PositionReport) {
    // insert one row into the langs table
    db.prepare('INSERT INTO positionreports(time, lat, lon, sog, cog, tws, twa, twd) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        new Date(report.time).toISOString(),
        report.lat, report.lon,
        report.sog, report.cog,
        report.tws, report.twa, report.twd
      )

    app.debug(`** Wrote position report to DB: ${JSON.stringify(report)}`)
  }

  function createPassage(startTime: number) {
    db.prepare('INSERT INTO passages(start, status) VALUES(?, ?)')
      .run(new Date(startTime).toISOString(), 'Recording')
  }

  function closePassageRecord(startTime: number, endTime: number) {
    db.prepare('UPDATE passages SET end = ?, status = ? WHERE start = ?')
      .run(new Date(endTime).toISOString(), 'Completed', new Date(startTime).toISOString())
  }

  // Get the start time of the current passage being recorded
  function getPassageStart() {
    const row = db.prepare('SELECT start FROM passages WHERE end IS NULL').get()
    return row ? row.start : row
  }

  export function getPositionReportCount(): number {
    return db.prepare('SELECT count(*) FROM positionreports').pluck().get()
  }

  function getLastPR() {
    const row = db.prepare('SELECT * FROM positionreports ORDER BY time DESC LIMIT 1').get()

    if (row) {
      return { time: row.time, lat: row.lat, lon: row.lon, cog: row.cog, sog: row.sog, tws: row.tws, twa: row.twa, twd: row.twd }
    } else {
      return null
    }
  }

  // Get a list of passages
  export function getPassages() {
    let results

    try {
      results = db.prepare('SELECT * FROM passages ORDER BY start DESC').all()
    } catch {
    }

    return results
  }

  export function getQueuedPassages() {
    let results

    try {
      results = db.prepare('SELECT * FROM passages WHERE status = ?').all('Queued')
    } catch {
    }

    return results
  }

  export function setPassageStatus(time: any, status: string) {
    db.prepare('UPDATE passages SET status = ? WHERE start = ?').run(status, time)
  }

  export function deletePassage(start: any, end: any) {
    db.prepare('DELETE FROM passages WHERE start = ? AND end = ?').run(start, end)
    db.prepare('DELETE FROM positionreports WHERE time >= ? AND time <= ?').run(start, end)
  }

}
