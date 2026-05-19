import { Component, Input, inject } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { TranslateModule } from '@ngx-translate/core';
import { EpgItemDescriptionComponent } from 'components';
import { EpgItem } from 'shared-interfaces';

@Component({
    selector: 'app-epg-view',
    templateUrl: './epg-view.component.html',
    imports: [MatIconButton, MatIcon, MatListModule, TranslateModule],
    styleUrls: ['./epg-view.component.scss'],
})
export class EpgViewComponent {
    @Input() epgItems: EpgItem[] = [];

    dialog = inject(MatDialog);

    private getProgramBounds(item: EpgItem): { start: number; stop: number } {
        const startFromTimestamp = Number(item.start_timestamp);
        const stopFromTimestamp = Number(item.stop_timestamp);

        if (
            Number.isFinite(startFromTimestamp) &&
            Number.isFinite(stopFromTimestamp)
        ) {
            return {
                start: startFromTimestamp * 1000,
                stop: stopFromTimestamp * 1000,
            };
        }

        const end = item.stop ?? item.end;
        return {
            start: new Date(item.start).getTime(),
            stop: new Date(end).getTime(),
        };
    }

    private formatTimestamp(
        timestampMs: number,
        includeDate = false,
        _timeZone?: 'UTC'
    ): string {
        // Always use America/Chicago (Central Time) for browser EPG
        const timeZone = 'America/Chicago';
        const timeText = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone,
        }).format(timestampMs);

        if (!includeDate) {
            return timeText;
        }

        const dateText = new Intl.DateTimeFormat('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            timeZone,
        }).format(timestampMs);

        return `${timeText} (${dateText})`;
    }

    formatStart(item: EpgItem): string {
        const timestamp = Number(item.start_timestamp);
        if (Number.isFinite(timestamp)) {
            const tzOffset = new Date().getTimezoneOffset();
            console.log('[EPG] start_timestamp:', timestamp, 'decoded ms:', timestamp * 1000, 'date:', new Date(timestamp * 1000).toISOString(), 'browser tz offset (min):', tzOffset, 'tz hours:', tzOffset / 60);
            return this.formatTimestamp(timestamp * 1000);
        }

        const fallback = new Date(item.start).getTime();
        return Number.isFinite(fallback)
            ? this.formatTimestamp(fallback)
            : '--:--';
    }

    formatEnd(item: EpgItem): string {
        const timestamp = Number(item.stop_timestamp);
        if (Number.isFinite(timestamp)) {
            return this.formatTimestamp(timestamp * 1000, true);
        }

        const fallback = new Date(item.stop ?? item.end).getTime();
        return Number.isFinite(fallback)
            ? this.formatTimestamp(fallback, true)
            : '--:--';
    }

    isCurrentProgram(item: EpgItem): boolean {
        const { start, stop } = this.getProgramBounds(item);
        const now = new Date().getTime();
        return now >= start && now <= stop;
    }

    getProgress(item: EpgItem): number {
        const { start, stop } = this.getProgramBounds(item);
        const now = new Date().getTime();

        const total = stop - start;
        const current = now - start;

        return Math.min(Math.max((current / total) * 100, 0), 100);
    }

    showDetails(item: EpgItem) {
        this.dialog.open(EpgItemDescriptionComponent, {
            data: {
                title: item.title ?? 'No title',
                desc: item.description ?? 'No description',
            },
        });
    }
}
