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
        // Prefer the ISO `start` / `stop` strings — the API layer
        // (xtream-api.service.ts) applies the server-side timezone correction
        // to those, but leaves the raw `*_timestamp` fields untouched.
        const startFromIso = new Date(item.start).getTime();
        const stopFromIso = new Date(item.stop ?? item.end).getTime();

        if (Number.isFinite(startFromIso) && Number.isFinite(stopFromIso)) {
            return { start: startFromIso, stop: stopFromIso };
        }

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

        return { start: NaN, stop: NaN };
    }

    private formatTimestamp(timestampMs: number, includeDate = false): string {
        // Use the browser's local timezone so EPG times match the user's wall clock.
        const timeText = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(timestampMs);

        if (!includeDate) {
            return timeText;
        }

        const dateText = new Intl.DateTimeFormat(undefined, {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
        }).format(timestampMs);

        return `${timeText} (${dateText})`;
    }

    formatStart(item: EpgItem): string {
        const { start } = this.getProgramBounds(item);
        return Number.isFinite(start) ? this.formatTimestamp(start) : '--:--';
    }

    formatEnd(item: EpgItem): string {
        const { stop } = this.getProgramBounds(item);
        return Number.isFinite(stop) ? this.formatTimestamp(stop, true) : '--:--';
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
