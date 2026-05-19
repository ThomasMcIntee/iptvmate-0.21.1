import {
    Component,
    HostBinding,
    inject,
    input,
    output,
} from '@angular/core';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { DataService } from 'services';
import { GLOBAL_FAVORITES_PLAYLIST_ID } from 'shared-interfaces';
//import { shell } from 'electron';
import { AddPlaylistMenuComponent, PlaylistType } from 'components';
import { AboutDialogComponent } from '../about-dialog/about-dialog.component';
import { AddPlaylistDialogComponent } from '../add-playlist/add-playlist-dialog.component';
import { FilterSortMenuComponent } from '../filter-sort-menu/filter-sort-menu.component';

@Component({
    selector: 'app-header',
    templateUrl: './header.component.html',
    styleUrls: ['./header.component.scss'],
    imports: [
        AddPlaylistMenuComponent,
        FilterSortMenuComponent,
        FormsModule,
        MatBadgeModule,
        MatButtonModule,
        MatDividerModule,
        MatIconModule,
        MatMenuModule,
        MatTooltipModule,
        ReactiveFormsModule,
        TranslateModule,
    ],
})
export class HeaderComponent {
    @HostBinding('class.home-header') get isHomeHeader() {
        return this.isHome;
    }

    private dialog = inject(MatDialog);
    private dataService = inject(DataService);
    private router = inject(Router);


    readonly isDesktop = !!window.electron;
    readonly title = input.required<string>();
    readonly subtitle = input.required<string>();
    readonly searchQuery = output<string>();
    readonly globalSearchClicked = output<void>();
    readonly globalRecentClicked = output<void>();

    get isHome(): boolean {
        const url = this.router.url || '';
        return url === '' || url === '/' || url.startsWith('/?');
    }

    get showFilterControls(): boolean {
        const url = this.router.url || '';
        // Tune icon (desktop/mobile): Home + M3U playlist pages.
        // Xtream/Portal pages have their own dedicated in-page filters.
        return this.isHome || /^\/(playlists(?:\/|$)|iptv(?:\/|$))/.test(url);
    }

    get showFilterRow(): boolean {
        // Header search + quick-filter row: only M3U playlist pages, not Home.
        const url = this.router.url || '';
        return /^\/(playlists(?:\/|$)|iptv(?:\/|$))/.test(url);
    }

    /**
     * Navigates to the settings page
     */
    openSettings(): void {
        this.router.navigate(['/settings']);
    }

    /**
     * Navigates to the global favorites view
     */
    navigateToGlobalFavorites(): void {
        this.router.navigate(['playlists', GLOBAL_FAVORITES_PLAYLIST_ID]);
    }

    /**
     * Opens the provided URL string in new browser window
     * @param url url to open
     */
    async openUrl(url: string): Promise<void> {
        if (this.isDesktop) {
            console.log('TODO: implement me');
            // await shell.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    }

    /**
     * Opens the about dialog with description and version of
     * the app
     */
    openAboutDialog(): void {
        this.dialog.open(AboutDialogComponent, {
            panelClass: 'about-dialog-overlay',
            width: '600px',
            data: this.dataService.getAppVersion(),
        });
    }

    openAddPlaylistDialog(type: PlaylistType) {
        this.dialog.open<AddPlaylistDialogComponent, { type: PlaylistType }>(
            AddPlaylistDialogComponent,
            {
                width: '600px',
                data: { type },
            }
        );
    }

    onSearchQueryUpdate(query: string): void {
        this.searchQuery.emit(query);
    }

    onGlobalSearchClick(): void {
        this.globalSearchClicked.emit();
    }

    onGlobalRecentClick(): void {
        this.globalRecentClicked.emit();
    }
}
