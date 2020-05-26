import { IPositionReport, IPassage } from './common'

const sqlite = require("better-sqlite3")

export class Database {

  db

  public constructor(dbPath: string) {
    this.createDatabase(dbPath)
  }

  // Create SQLite Database if it doesn't exist
  private createDatabase(dbPath: string) {
    this.db = new sqlite(dbPath)
    this.db.prepare("CREATE TABLE IF NOT EXISTS positionreports (time TEXT, lat REAL, lon REAL, sog REAL, cog INTEGER, tws REAL, twa INTEGER, twd INTEGER)").run()
    this.db.prepare("CREATE TABLE IF NOT EXISTS passages (start TEXT, end TEXT, status TEXT)").run()
  }

  createPassage(startTime: number) {
    this.db.prepare('INSERT INTO passages(start, status) VALUES(?, ?)')
      .run(new Date(startTime).toISOString(), 'Recording')
  }

  getPassages(): Array<IPassage> {
    return this.db.prepare('SELECT * FROM passages ORDER BY start DESC').all()
  }

  getQueuedPassages(): Array<IPassage> {
    return this.db.prepare('SELECT * FROM passages WHERE status = ?').all('Queued')
  }

  closePassageRecord(startTime: number, endTime: number) {
    this.db.prepare('UPDATE passages SET end = ?, status = ? WHERE start = ?')
      .run(new Date(endTime).toISOString(), 'Completed', new Date(startTime).toISOString())
  }

   // Get the start time of the current passage being recorded
  getPassageStart(): string {
    const result = this.db.prepare('SELECT start FROM passages WHERE end IS NULL').get()
    return result ? result.start : null
  }

  getPassageStatus(start: string): 'creategpx' | 'getpsurl' | 'uploads3' | 'queue' | 'creategpx - failed' | 'getpsurl - failed' | 'uploads3 - failed' | 'queue - failed' {
    try {
      const result = this.db.prepare('SELECT status FROM passages WHERE start = ?').get(start)
      return result ? result.status : null
    } catch (error) {
      console.log(`DATABASE ERROR: ${error}`)
      return null
    }
  }

  // Write position report to the DB
  writePositionReportToDB(report: IPositionReport) {
    // insert one row into the langs table
    this.db.prepare('INSERT INTO positionreports(time, lat, lon, sog, cog, tws, twa, twd) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        new Date(report.time).toISOString(),
        report.lat, report.lon,
        report.sog, report.cog,
        report.tws, report.twa, report.twd
      )
  }

  getPassagePRs(startDate, endDate) {
    return this.db.prepare('SELECT * FROM positionreports WHERE time >= ? AND time <= ?').all(startDate, endDate)
  }

  getPositionReportCount(start: any): number {
    return this.db.prepare('SELECT count(*) FROM positionreports WHERE time >= ?').pluck().get(start)
  }

  setPassageStatus(start: any, status: 'creategpx' | 'getpsurl' | 'uploads3' | 'queue' | 'creategpx - failed' | 'getpsurl - failed' | 'uploads3 - failed' | 'queue - failed') {
    this.db.prepare('UPDATE passages SET status = ? WHERE start = ?').run(status, start)
  }

  deletePassage(start: string, end: string) {
    this.db.prepare('DELETE FROM passages WHERE start = ? AND end = ?').run(start, end)
    this.db.prepare('DELETE FROM positionreports WHERE time >= ? AND time <= ?').run(start, end)
  }

  getLastPR() {
    const row = this.db.prepare('SELECT * FROM positionreports ORDER BY time DESC LIMIT 1').get()

    if (row) {
      return { time: row.time, lat: row.lat, lon: row.lon, cog: row.cog, sog: row.sog, tws: row.tws, twa: row.twa, twd: row.twd }
    } else {
      return null
    }
  }

  close() {
    this.db.close()
  }
}
