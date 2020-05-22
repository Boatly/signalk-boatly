import { Component } from '@angular/core';
import { SignalKClient } from 'signalk-client-angular';
import { HttpParams, HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { catchError } from 'rxjs/operators';
import { Observable, of, throwError, concat } from 'rxjs';
import { map, delay, retryWhen, take, timeout } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  title = 'signalk-boatly';
  repeat = 0
  passages = null
  public recording = 'Recording'
  authToken = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0YjM2YWZjOC01MjA1LTQ5YzEtYWYxNi00ZGM2Zjk2ZGI5ODIiLCJpc3MiOiJCb2F0bHkuY29tIiwiaWF0IjoxNTgxMzY1NDc4fQ.NmEmiN3OFtALR8BWPM3m6QxjKC6AloXNaoM4jnLfO70'

  constructor(
    private sk: SignalKClient, 
    private http: HttpClient
    ) {
    this.sk.connect('localhost', 3000, false)
      .then(r => { 
        this.getPassages()        
      })
      .catch(e => { })           
  }

  // Retrieve a list of passages that require processing
  getPassages() {
    this.recording = 'Recording' + '.'.repeat(this.repeat)

    if (this.repeat > 2) {
      this.repeat = 0;
    } else {
      this.repeat += 1
    }
    
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
    this.sk.api.post('vessels/self/process', {start: passage.start, end: passage.end}).subscribe(
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
    this.sk.api.post('vessels/self/discard', {start: passage.start, end: passage.end}).subscribe(
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

  finishPassage(passage: any) {    
    this.sk.api.post('vessels/self/finish', {}).subscribe(
      (response: any) => {
        console.log(response.status)
        passage.end = new Date().toISOString()
        passage.status = response.status        
      },
      error => {
        console.log(error)
      }
    )
  }

  getS3SignedURLForImport(fileName: string) {
    
    const httpOptions = {
      headers: new HttpHeaders({'Authorization': this.authToken}),
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
