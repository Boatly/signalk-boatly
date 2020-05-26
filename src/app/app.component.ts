import { Component, OnDestroy, OnInit, isDevMode } from '@angular/core';
import { SignalKClient } from 'signalk-client-angular';
import { HttpParams, HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { Observable, of, throwError, concat } from 'rxjs';
import { map, delay, retryWhen, take, timeout } from 'rxjs/operators';
import { THIS_EXPR } from '@angular/compiler/src/output/output_ast';

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

  title = 'signalk-boatly';
  repeat = 0
  passages = null

  authToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0YjM2YWZjOC01MjA1LTQ5YzEtYWYxNi00ZGM2Zjk2ZGI5ODIiLCJpc3MiOiJCb2F0bHkuY29tIiwiaWF0IjoxNTgxMzY1NDc4fQ.NmEmiN3OFtALR8BWPM3m6QxjKC6AloXNaoM4jnLfO70'

  status = null
  statusTitle = ''
  additionalInfo = null

  intervalID

  constructor(private sk: SignalKClient, private http: HttpClient) {
    // Construct host for connection
    this.hostName = (this.devMode && this.DEV_SERVER.host) ? this.DEV_SERVER.host : window.location.hostname;
    this.hostPort = (this.devMode && this.DEV_SERVER.port) ? this.DEV_SERVER.port : parseInt(window.location.port);
    this.hostSSL = (window.location.protocol == 'https:' || (this.devMode && this.DEV_SERVER.ssl)) ? true : false;
    this.host = (this.devMode) ? `${this.hostSSL ? 'https:' : 'http:'}//${this.hostName}:${this.hostPort}` : `${window.location.protocol}//${window.location.host}`;
  }

  ngOnInit() {
    console.log(`HOST: ${this.host}`)

    this.sk.connect(this.hostName, this.hostPort, this.hostSSL).then(r => {
      this.status = `Connected to SignalK Server ${this.host}`
      console.log(this.status)
      this.getStatus()
      this.getPassages()
      this.intervalID = setInterval(() => this.getStatus(), 1000)
    })
      .catch(e => {
        this.status = `Failed to connect to SignalK Server ${this.host}`
        console.log(this.status)
      })
  }

  ngOnDestroy() {
    this.sk.disconnect()
    clearInterval(this.intervalID)
  }

  getStatus() {
    this.sk.api.get('self/status').subscribe(
      (response: any) => {
        this.status = response
        this.decodeStatus()
      }
    )
  }

  decodeStatus() {
    switch (this.status.status) {

      case 'RECORDING':
        this.statusTitle = 'Recording'
        this.additionalInfo = `${this.status.prs} positions recorded`
        break;

      case 'WAITING_INITIAL_POSITION':
        this.statusTitle = 'Waiting'
        this.additionalInfo = null
        break;

      case 'READY':
        this.statusTitle = 'Ready'
        this.additionalInfo = null
        break;

      case 'STOPPED':
        this.statusTitle = 'Vessel Stopped'
        const minutes = Math.floor(this.status.stoppedmins)
        const seconds = Math.round(this.status.stoppedmins % 1 * 60);
        this.additionalInfo = `Stopped for ${minutes} minute(s) ${seconds} seconds`
        break;

      default:
        break;
    }
  }

  // Retrieve a list of passages that require processing
  getPassages() {
    this.sk.api.get('vessels/self/log').subscribe(
      (response: any) => {
        this.passages = response

        if (this.passages.filter(passage => (passage.status === 'Uploading' || passage.status === 'Queued')).length > 0) {
          setTimeout(this.getPassages.bind(this), 5000)
          console.log("Callliing a gain")
        }
      },
      error => {
        console.log(error)
      }
    );
  }

  processPassage(passage: any) {
    this.sk.api.post('vessels/self/process', { start: passage.start, end: passage.end }).subscribe(
      (response: any) => {
        console.log(response.status)
        passage.status = response.status
        // this.getPassages()
      },
      error => {
        console.log(error)
      }
    )
  }

  discardPassage(passage: any) {
    this.sk.api.post('vessels/self/discard', { start: passage.start, end: passage.end }).subscribe(
      (response: any) => {
        console.log(response.status)
        passage.status = response.status
        this.getPassages()
      },
      error => {
        console.log(error)
      }
    )
  }

  finishPassage() {
    this.sk.api.post('vessels/self/finish', {}).subscribe(
      (response: any) => {
        this.getPassages()
        // console.log(response.status)
        // passage.end = new Date().toISOString()
        // passage.status = response.status
      },
      error => {
        console.log(error)
      }
    )
  }

  getS3SignedURLForImport(fileName: string) {

    const httpOptions = {
      headers: new HttpHeaders({ 'Authorization': this.authToken }),
      params: new HttpParams().set('file-name', fileName)
    };

    return this.http.get(`https://boatly-api.herokuapp.com/v1/s3/signimport`, httpOptions).pipe(
      catchError(this.handleError)
    );
  }

  private handleError(error: HttpErrorResponse) {
    let msg = 'Oops! Something went wrong!  We\'ve recorded the problem and will look into it.';

    if (error.error instanceof ErrorEvent) {
      // A client-side or network error occurred. Handle it accordingly.
      console.error('An error occurred:', error.error.message);
    } else {
      // The backend returned an unsuccessful response code.
      // The response body may contain clues as to what went wrong,

      if (error.status === 0) {
        // Could not connect to the server, it may be down.  Tell the user to try again.
        msg = 'There seems to be a temporary problem, please try again.';
      }

      console.error(
        `Backend returned code ${error.status}, ` +
        `body was: ${error.error}`);
    }

    // return an ErrorObservable with a user-facing error message
    return throwError(msg);
  };
}
