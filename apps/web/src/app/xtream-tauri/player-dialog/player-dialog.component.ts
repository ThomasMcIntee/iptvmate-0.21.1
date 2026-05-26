import { ClipboardModule } from '@angular/cdk/clipboard';
import { Component, inject, signal, ViewEncapsulation } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import {
    MAT_DIALOG_DATA,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WebPlayerViewComponent } from 'shared-portals';
import { XtreamStore } from '../stores/xtream.store';

export interface PlayerDialogData {
    streamUrl: string;
    title: string;
    contentInfo?: any;
    startTime?: number;
    subtitleUrl?: string;
}

@Component({
    templateUrl: './player-dialog.component.html',
    imports: [
        ClipboardModule,
        MatButton,
        MatIconButton,
        MatDialogModule,
        MatIcon,
        MatTooltip,
        TranslatePipe,
        WebPlayerViewComponent,
    ],
    styleUrl: './player-dialog.component.scss',
    encapsulation: ViewEncapsulation.None,
})
export class PlayerDialogComponent {
    readonly data = inject<PlayerDialogData>(MAT_DIALOG_DATA);
    private snackBar = inject(MatSnackBar);
    private translateService = inject(TranslateService);
    private readonly xtreamStore = inject(XtreamStore);
    private readonly dialogRef = inject(
        MatDialogRef<PlayerDialogComponent>
    );

    readonly title: string;
    readonly streamUrl: string;
    readonly isFullscreen = signal(false);

    private lastSaveTime = 0;
    private previousSize: {
        width?: string;
        height?: string;
        maxWidth?: string;
        maxHeight?: string;
    } | null = null;

    constructor() {
        this.streamUrl = this.data.streamUrl;
        this.title = this.data.title;
    }

    toggleDialogFullscreen() {
        const next = !this.isFullscreen();
        this.isFullscreen.set(next);
        const containerEl =
            this.dialogRef
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ._containerInstance?.['_elementRef']?.nativeElement as
                | HTMLElement
                | undefined;

        if (next) {
            // Remember current size and expand to viewport.
            this.previousSize = {
                width: this.dialogRef.componentInstance ? '80%' : undefined,
            };
            this.dialogRef.updateSize('100vw', '100vh');
            this.dialogRef.addPanelClass('player-dialog-fullscreen');
            if (containerEl) {
                containerEl.classList.add('player-dialog-fullscreen');
            }
            // Also push Electron BrowserWindow to fullscreen when available.
            const api = (window as any).electron;
            if (api?.toggleFullScreen) {
                try {
                    api.toggleFullScreen();
                } catch {
                    /* ignore */
                }
            }
        } else {
            this.dialogRef.updateSize('80%', '');
            this.dialogRef.removePanelClass('player-dialog-fullscreen');
            if (containerEl) {
                containerEl.classList.remove('player-dialog-fullscreen');
            }
            const api = (window as any).electron;
            if (api?.toggleFullScreen) {
                try {
                    api.toggleFullScreen();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    handleTimeUpdate(event: { currentTime: number; duration: number }) {
        if (!this.data.contentInfo) return;

        const now = Date.now();
        // Save every 15 seconds
        if (now - this.lastSaveTime > 15000) {
            this.lastSaveTime = now;
            this.xtreamStore.savePosition(this.data.contentInfo.playlistId, {
                ...this.data.contentInfo,
                positionSeconds: Math.floor(event.currentTime),
                durationSeconds: Math.floor(event.duration),
            });
        }
    }

    showCopyNotification() {
        this.snackBar.open(
            this.translateService.instant('PORTALS.STREAM_URL_COPIED'),
            null,
            {
                duration: 2000,
            }
        );
    }
}
