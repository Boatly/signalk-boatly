export interface IPassage {
  start: string,
  end: string,
  status: string
}

export interface IPositionReport {
  time: number,
  lon: number | undefined,
  lat: number | undefined,
  sog: number | undefined,
  cog: number | undefined,
  tws: number | undefined,
  twa: number | undefined,
  twd: number | undefined,
}

export interface IJob {
  start: string,
  end: string,
  gpxpath: string,
  gpxfilename: string,
  dbPath: string,
  authToken: string,
  status?: string,
  psurl?: string,
  passageid?: string
}
