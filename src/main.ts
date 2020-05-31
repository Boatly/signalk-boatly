import 'hammerjs';
import { enableProdMode } from '@angular/core';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

// if (environment.production) {
  // HACK: TODO: hardcoding for now as not working when published to npm
  enableProdMode();
//}

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
