import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

if (
    typeof window !== 'undefined' &&
    window.location.hostname === 'localhost' &&
    'serviceWorker' in navigator
) {
    void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
            Promise.all(registrations.map((registration) => registration.unregister()))
        )
        .catch(() => {
            // Ignore cleanup failures in development.
        });
}

bootstrapApplication(AppComponent, appConfig).catch((err) =>
    console.error(err)
);
