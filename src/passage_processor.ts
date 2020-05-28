import { Database } from './database'
import { IJob, PassageStatus, JobStatus, ResponseStatus } from './common'
const path = require('path');

const axios = require('axios').default
const Queue = require('better-queue');
const fs = require('fs');

export class PassageProcessor {

  q

  constructor() {
    this.q = new Queue(this.processPassage) // , , { maxTimeout: 2000 } , { afterProcessDelay: 4000 }
  }

  // Add a passage to the queue of passages to be processed by Boatly
  public queuePassage(job: IJob) {
    const that = this

    this.q.push(job)
      .on('finish', function (result) {
        // If the job is finished ('processed') or failed then set the passage status
        if (job.status === JobStatus.Processed || (job.status >= JobStatus.CreatedGPXFailed && job.status <= JobStatus.QueueFailed)) {

          let status

          if (job.status === JobStatus.Processed) {
            status = PassageStatus.Processed
          } else {
            if (job.status === JobStatus.CreatedGPXFailed) {
              status = PassageStatus.CreatedGPXFailed
            } else if (job.status === JobStatus.GetPSURLFailed) {
              status = PassageStatus.GetPSURLFailed
            } else if (job.status === JobStatus.QueueFailed) {
              status = PassageStatus.QueueFailed
            } else if (job.status === JobStatus.UploadS3Failed) {
              status = PassageStatus.UploadS3Failed
            }
          }

          new Database(job.dbPath).setPassageStatus(job.start, status)

        } else {
          // Otherwise re-queue it
          that.queuePassage(job)
        }
      })
      .on('failed', function (error) {
        console.log(`Job failed ${error}`)
      })
  }

  async processPassage(job: IJob, callback) {

    // Retrieve the passage from the database
    let status = job.status

    // Stage 1 - create the gpx file
    if (status === JobStatus.CreateGPX) {
      const response = await exportToGPX(job)
      status = (response === ResponseStatus.OK) ? JobStatus.GetPSURL : JobStatus.CreatedGPXFailed
    }

    // Stage 2 - get an AWS Presigned URL to upload the gpx file to
    else if (status === JobStatus.GetPSURL) {
      const response = await getAWSPresignedURL(job)

      if (response === ResponseStatus.Failed) {
        status = JobStatus.GetPSURLFailed
      } else {
        job.psurl = response.url
        job.passageid = response.passageid
        status = JobStatus.UploadS3
      }
    }

    // Stage 3 - upload to psurl
    else if (status === JobStatus.UploadS3) {
      const response = await uploadToS3(job.gpxFilename, job.psurl)
      status = (response === ResponseStatus.OK) ? JobStatus.Queue : JobStatus.UploadS3Failed
    }

    // Stage 4 - Queue passage for import with boatly
    else if (status === JobStatus.Queue) {
      const response = await queueImport(job.gpxFilename, job.userID, job.passageid, job.authToken)
      status = (response === ResponseStatus.OK) ? JobStatus.Processed : JobStatus.QueueFailed
    }

    // Set the job status so that it can be re-queued for the next stage of the process
    job.status = status

    callback()

    async function exportToGPX(job: IJob) {
      try {
        // Retrieve the passage PRs from the database
        let prs = new Database(job.dbPath).getPassagePRs(job.start, job.end)

        // Write to the GPX file
        fs.appendFileSync(job.gpxFilename, `<?xml version='1.0'?><gpx version='1.0'><trk><trkseg>`)

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

          fs.appendFileSync(job.gpxFilename, trckpt)
        });

        fs.appendFileSync(job.gpxFilename, `</trkseg></trk></gpx>`)

        return ResponseStatus.OK
      }
      catch (error) {
        return ResponseStatus.Failed
      }
    }

    async function getAWSPresignedURL(job: IJob) {
      try {
        // Get a pre-shared-url
        const options = {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': job.authToken
          }
        };

        const fileName = path.basename(job.gpxFilename)

        const response: any = await axios.get(`https://boatly-api.herokuapp.com/v1/s3/signimport?file-name=${fileName}`, options)

        // If this failed set the item's status to failed and don't continue
        if (response.status !== 200) {
          console.log(`Failed to get pre-signed URL: ${response.statusText}`)
          return ResponseStatus.Failed
        } else {
          return response.data
        }
      }
      catch (error) {
        return ResponseStatus.Failed
      }
    }

    async function uploadToS3(filename: string, presignedUrl: string) {
      try {
        const stream = fs.createReadStream(filename)

        stream.on('error', console.log)

        const { size } = fs.statSync(filename)

        await axios({
          method: 'PUT',
          url: presignedUrl,
          headers: {
            'Content-Type': 'application/gpx+xml',
            'Content-Length': size,
          },
          data: stream
        })

        stream.close()

        return ResponseStatus.OK
      }
      catch (error) {
        return ResponseStatus.Failed
      }
    }

    async function queueImport(filename: string, user_id: string, passageID: string, authToken: string) {
      try {
        const payload = {
          filename: path.basename(filename),
          userid: user_id,
          passageid: passageID
        }

        const options = {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': job.authToken
          }
        };

        const response = await axios.post(`https://boatly-api.herokuapp.com/v1/mq/import`, payload, options)

        if (response.status === 200) {
          return ResponseStatus.OK
        } else {
          console.log(`Failed to queue passage: ${response.statusText}`)
          return ResponseStatus.Failed
        }
      }

      catch (error) {
        return ResponseStatus.Failed
      }
    }
  }

}
