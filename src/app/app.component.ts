import { Component, OnDestroy, OnInit, isDevMode } from '@angular/core';
import { SignalKClient } from 'signalk-client-angular';
import { MatSnackBar } from '@angular/material';

interface IStatus {
  status: string,
  description: string,
  prs: number,
  stoppedmins: number
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit, OnDestroy {

  private DEV_SERVER = {
    host: 'localhost',
    port: 3000,
    ssl: false
  };

  hostName: string;
  hostPort: number;
  hostSSL: boolean;
  host = '';
  devMode = isDevMode()
  deleting = false
  timeoutID

  passages = null

  statusResponse: IStatus = null

  isLoggedIn = true

  statusTitle = ''
  statusSubtitle = ''
  additionalInfo = null

  DBPath = ''

  intervalID

  noRecordedPassages = true
  completedPassages = false

  constructor(private sk: SignalKClient, private _snackBar: MatSnackBar) {
    // Construct host for connection
    this.devMode = false // HACK: TODO: hardcoding for now as not working when published to npm
    this.hostName = (this.devMode && this.DEV_SERVER.host) ? this.DEV_SERVER.host : window.location.hostname;
    this.hostPort = (this.devMode && this.DEV_SERVER.port) ? this.DEV_SERVER.port : parseInt(window.location.port);
    this.hostSSL = (window.location.protocol == 'https:' || (this.devMode && this.DEV_SERVER.ssl)) ? true : false;
    this.host = (this.devMode) ? `${this.hostSSL ? 'https:' : 'http:'}//${this.hostName}:${this.hostPort}` : `${window.location.protocol}//${window.location.host}`;

    this.devMode ? console.log('** Starting in Development Mode **') : console.log('** Starting in Production Mode **')
  }

  ngOnInit() {
    this.statusResponse = {status: 'CONNECTSIGNALK', description: '', prs: 0, stoppedmins: 0}
    this.decodeStatus()

    this.sk.connect(this.hostName, this.hostPort, this.hostSSL).subscribe(
      (res) => {
        this.statusTitle = `Connected to SignalK Server ${this.host}`
        // this.getStatus()
        this.getPassages()
        this.getDBPath()
        this.intervalID = setInterval(() => this.getStatus(), 2000)
      },

      (error) => {
        this.statusResponse = {status: 'FAILEDCONNECTSIGNALK',description: `${error.message}`, prs: 0, stoppedmins: 0}
        this.decodeStatus()
      }
    )
  }

  ngOnDestroy() {
    this.sk.disconnect()
    clearInterval(this.intervalID)
  }

  getStatus() {
    this.sk.api.get('self/signalkboatly/status').subscribe(
      (response: any) => {
        this.statusResponse = response.status
        this.isLoggedIn = response.loggedin
        this.decodeStatus()
      }
    )
  }

  getDBPath() {
    this.sk.api.get('self/signalkboatly/databasepath').subscribe(
      (response: any) => {
        this.DBPath = response.path
        this.decodeStatus()
      }
    )
  }

  decodeStatus() {
    this.statusSubtitle = this.statusResponse.description

    switch (this.statusResponse.status) {

      case 'CONNECTSIGNALK':
        this.statusTitle = 'Connecting to SignalK Server'
        this.statusSubtitle = 'Establishing a connection to your SignalK server'
        this.additionalInfo = `Connecting to host: ${this.host}`
        break;

      case 'FAILEDCONNECTSIGNALK':
        this.statusTitle = `Failed to connect to SignalK`
        this.statusSubtitle = `Failed to connect to SignalK Server ${this.host}`
        this.additionalInfo = this.statusResponse.description
        break;

      case 'RECORDING':
        this.statusTitle = 'Recording'
        this.additionalInfo = `${this.statusResponse.prs} positions recorded`
        break;

      case 'WAITING_INITIAL_POSITION':
        this.statusTitle = 'Connected - Waiting'
        this.additionalInfo = 'A connection to your SignalK server has been established.  Boatly Passage logger is waiting for a position report from your GPS.'
        break;

      case 'READY':
        this.statusTitle = 'Ready'
        this.additionalInfo = 'Recording will start when your vessels starts to move.'
        break;

      case 'STOPPED':
        this.statusTitle = 'Vessel Stopped'
        const minutes = Math.floor(this.statusResponse.stoppedmins)
        const seconds = Math.round(this.statusResponse.stoppedmins % 1 * 60);
        this.additionalInfo = `Stopped for ${minutes} minute(s) ${seconds} seconds`
        break;

      default:
        break;
    }
  }

  // Retrieve a list of passages that require processing
  getPassages() {
    if (this.timeoutID) {
      clearTimeout(this.timeoutID)
      this.timeoutID = null
    }

    this.sk.api.get('vessels/self/signalkboatly/log').subscribe(
      (response: any) => {
        this.passages = response

        // Handle edge case where passage status is not in list of know statuses (happens when API was updated to new status values)
        this.handleUnknownStatuses()
        this.noRecordedPassages = (this.passages.filter(passage => (passage.status !== 'recording')).length === 0)
        this.completedPassages = (this.passages.filter(passage => (passage.status === 'processed')).length > 0)

        if (this.passages.filter(passage => (passage.status === 'processing')).length > 0) {
          this.timeoutID = setTimeout(this.getPassages.bind(this), 5000)
        }
      },
      error => {
        console.log(`** Failed vessels/self/signalkboatly/log :  ${JSON.stringify(error)}`)
      }
    );
  }

  handleUnknownStatuses() {
    for (let passage of this.passages) {
      console.log(passage.status)
      if (passage.status !== 'recording' && passage.status !== 'completed' && passage.status !== 'processing' && passage.status != 'processed') {
        passage.status = 'completed'
      }
    }
  }

  downloadGPX(passage: any) {
    window.location.href = `${this.host}/signalk/v1/api/vessels/self/signalkboatly/downloadgpx?start=${passage.start}&end=${passage.end}`;
  }

  processPassage(passage: any) {
    if (this.isLoggedIn) {
      this.sk.api.post('vessels/self/signalkboatly/process', { start: passage.start, end: passage.end }).subscribe(
        (response: any) => {
          passage.status = response.status
          this.getPassages()
        },
        error => {
          console.log(error)
        }
      )
    }
    else {
      this._snackBar.open("Please authenticate with Boatly first", '', { duration: 2000 });
    }
  }

  discardPassage(passage: any) {
    this.sk.api.post('vessels/self/signalkboatly/discard', { start: passage.start, end: passage.end }).subscribe(
      (response: any) => {
        passage.status = response.status
        this.getPassages()
      },
      error => {
        console.log(`** Failed vessels/self/signalkboatly/discard: ${JSON.stringify(error)}`)
      }
    )
  }

  finishPassage() {
    this.sk.api.post('vessels/self/signalkboatly/finish', {}).subscribe(
      () => {
        this.getPassages()
      },
      error => {
        console.log(`** Failed vessels/self/signalkboatly/finish: ${JSON.stringify(error)}`)
      }
    )
  }

  deleteCompleted() {
    if (this.deleting) return

    this.deleting = true

    this.sk.api.post('vessels/self/signalkboatly/deletecompleted', {}).subscribe(
      () => {
        this.getPassages()
        this.deleting = false
      },
      error => {
        console.log(`** Failed vessels/self/signalkboatly/deletecompleted: ${JSON.stringify(error)}`)
        this.deleting = false
      }
    )
  }

  getFailedText(status: string) {
    switch (status) {
      case 'creategpx-failed':
        return 'Failed to create GPX file'
        break;

      case 'getpsurl-failed':
        return 'Failed to get pre-signed URL'
        break;

      case 'uploads3-failed':
        return 'Failed to upload GPX file'
        break;

      case 'queue-failed':
        return 'Failed to queue passage for import with Boatly server'
        break;

      default:
        return 'Failed'
        break;
    }
  }

}
