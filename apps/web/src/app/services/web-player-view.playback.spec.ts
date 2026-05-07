import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StorageMap } from '@ngx-pwa/local-storage';
import { of } from 'rxjs';
import { VideoPlayer } from 'shared-interfaces';
import { WebPlayerViewComponent } from 'shared-portals';

describe('WebPlayerViewComponent playback fallbacks', () => {
    let fixture: ComponentFixture<WebPlayerViewComponent>;
    let component: WebPlayerViewComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [WebPlayerViewComponent],
            providers: [
                {
                    provide: StorageMap,
                    useValue: {
                        get: jest.fn(() =>
                            of({
                                player: VideoPlayer.ArtPlayer,
                                showCaptions: false,
                            })
                        ),
                    },
                },
            ],
        })
            .overrideComponent(WebPlayerViewComponent, {
                set: { template: '' },
            })
            .compileComponents();

        fixture = TestBed.createComponent(WebPlayerViewComponent);
        component = fixture.componentInstance;
        (WebPlayerViewComponent as unknown as {
            pwaProxyBaseCache: string | null;
            pwaProbeInProgress: Promise<string | null> | null;
        }).pwaProxyBaseCache = null;
        (WebPlayerViewComponent as unknown as {
            pwaProbeInProgress: Promise<string | null> | null;
        }).pwaProbeInProgress = null;
    });

    afterEach(() => {
        jest.clearAllMocks();
        delete (globalThis as { fetch?: typeof fetch }).fetch;
    });

    it('forces the html5 fallback for proxied non-live streams', async () => {
        fixture.componentRef.setInput(
            'streamUrl',
            'http://localhost:3000/stream?url=' +
                encodeURIComponent(
                    'http://provider.example/movie/user/pass/77.mp4'
                )
        );
        fixture.detectChanges();

        await fixture.whenStable();

        expect(component.forceHtml5Fallback).toBe(true);
    });

    it('enables the videojs fallback after a live artplayer playback error', async () => {
        fixture.componentRef.setInput(
            'streamUrl',
            'http://provider.example/live/user/pass/414149.ts'
        );
        fixture.detectChanges();

        await fixture.whenStable();

        component.onArtPlayerPlaybackError();

        expect(component.forceVideoJsFallback).toBe(true);
    });
});