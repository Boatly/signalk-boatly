const axios = require('axios').default

export class RestAPI {

  baseURL: 'https://boatly-api.herokuapp.com/v1'

  constructor() { }

  async getPreSignedURL(filename: string, authToken: string) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authToken
    }

    return await axios.get(`s3/signimport?file-name=${filename}`, headers)
  }

  uploadAndQueue(path: string, filename: string, presignedUrl: string,
    authToken: string, userID: string, passageID: string) {

    var exec = require('child_process').exec;

    var args = ` -v -T ${path} '${presignedUrl}'`

    const that = this

    exec('curl ' + args, function (error, stdout, stderr) {
      if (error !== null) {
        console.log('exec error: ' + error);
      } else {
        console.log(`** 3 of 4 - Successfully uploaded passage **`)
        that.queueImport(filename, userID, passageID, authToken)
      }
    });

  }

  async queueImport(filename: string, user_id: string, passageID: string, authToken: string) {

    const payload = {
      filename: filename,
      userid: user_id,
      passageid: passageID
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authToken
    }

    axios.post(`${this.baseURL}mq/import`, payload, { headers: headers })
      .then((response: any) => {
        console.log(response.statusMessage)
        console.log(`** 4 of 4 - Successfully queued passage: ${filename} **`)
      })
      .catch((error: any) => {
        console.log(`** Failed to queue passage: ${JSON.stringify(error)}`)
      })
  }

}
