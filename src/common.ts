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
  gpxFilename: string,
  dbPath: string,
  authToken: string,
  userID: string,
  status: JobStatus,
  psurl?: string,
  passageid?: string
}

export enum JobStatus {
  CreateGPX,
  GetPSURL,
  UploadS3,
  Queue,
  Processed,
  CreatedGPXFailed,
  GetPSURLFailed,
  UploadS3Failed,
  QueueFailed
}

export enum PassageStatus {
  Recording = 'recording',
  Completed = 'completed',
  Processing = 'processing',
  Processed = 'processed',
  CreatedGPXFailed = 'creategpx-failed',
  GetPSURLFailed = 'getpsurl-failed',
  UploadS3Failed = 'uploads3-failed',
  QueueFailed = 'queue-failed'
}

export enum ResponseStatus {
  OK = 'OK',
  Failed = 'failed'
}
