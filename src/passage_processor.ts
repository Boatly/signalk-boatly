import { Database } from './database'
import { IJob } from './common'

const axios = require('axios').default
const Queue = require('better-queue');
const fs = require('fs');

export class PassageProcessor {

  q

  constructor() {
    this.q = new Queue(this.processPassage) // , { afterProcessDelay: 4000 }
  }

  // Add a passage to the queue of passages to be processed by Boatly
  public queuePassage(job: IJob) {
    const that = this

    this.q.push(job)
      .on('finish', function (result) {
        if (job.status !== 'processed' && job.status.indexOf('- failed') === -1) {
          that.queuePassage(job)
        }
      })
      .on('failed', function (error) {
        console.log(`Job failed ${error}`)
      })
  }

  async processPassage(job: IJob, callback) {

    // Retrieve the passage from the database
    let status

    try {
      status = new Database(job.dbPath).getPassageStatus(job.start)
    } catch (error) {
      console.log(`ERROR: ${error}`)
    }

    // Stage 1 - create the gpx file
    if (status === 'creategpx') {
      await exportToGPX(job)
      status = 'getpsurl'
    }

    // Stage 2 - get an AWS Presigned URL to upload the gpx file to
    else if (status === 'getpsurl') {
      const response = await getAWSPresignedURL(job)

      if (response === 'Failed') {
        status = 'getpsurl-failed'
      } else {
        job.psurl = response.url
        job.passageid = response.passageid
        status = 'uploads3'
      }
    }

    // Stage 3 - upload to psurl
    else if (status === 'uploads3') {
      const success = await uploadToS3(job.gpxpath, job.psurl)

      if (success === true) {
        status = 'queue'
      } else {
        status = 'uploads3-failed'
      }
    }

    // Stage 4 - Queue passage for import with boatly
    else if (status === 'queue') {
      const success = await queueImport(job.gpxfilename, '4b36afc8-5205-49c1-af16-4dc6f96db982', job.passageid, job.authToken)

      if (success === true) {
        status = 'processed'
      } else {
        status = 'queue-failed'
      }
    }

    const db = new Database(job.dbPath)

    // Re-queue job to move it to the next stage
    db.setPassageStatus(job.start, status)
    job.status = status

    callback()

    async function exportToGPX(job: IJob) {
      // Retrieve the passage PRs from the database
      let prs = new Database(job.dbPath).getPassagePRs(job.start, job.end)

      // Write to the GPX file
      fs.appendFileSync(job.gpxpath, `<?xml version='1.0'?><gpx version='1.0'><trk><trkseg>`)

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

        fs.appendFileSync(job.gpxpath, trckpt)
      });

      fs.appendFileSync(job.gpxpath, `</trkseg></trk></gpx>`)
    }

    async function getAWSPresignedURL(job: IJob) {
      // Get a pre-shared-url
      const options = {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': job.authToken
        }
      };

      const response: any = await axios.get(`https://boatly-api.herokuapp.com/v1/s3/signimport?file-name=${job.gpxfilename}`, options)

      // If this failed set the item's status to failed and don't continue
      if (response.status !== 200) {
        console.log(`Failed to get pre-signed URL: ${response.statusText}`)
        return 'Failed'
      } else {
        return response.data
      }
    }

    async function uploadToS3(path: string, presignedUrl: string) {

      const readmeStream = fs.createReadStream(path)
      readmeStream.on('error', console.log)
      const { size } = fs.statSync(path)

      const response = await axios({
        method: 'PUT',
        url: presignedUrl,
        headers: {
          'Content-Type': 'application/gpx+xml',
          'Content-Length': size,
        },
        data: readmeStream
      })

      return true
    }

    async function queueImport(filename: string, user_id: string, passageID: string, authToken: string) {
      const payload = {
        filename: filename,
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
        return true
      } else {
        console.log(`Failed to queue passage: ${response.statusText}`)
        return false
      }
    }

  }

}
