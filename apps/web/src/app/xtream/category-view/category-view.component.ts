import { Component, computed, inject, input, output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { FilterPipe } from '@iptvmate/pipes';
import { TranslatePipe } from '@ngx-translate/core';
import { XtreamCategory } from 'shared-interfaces';
import { PlaylistErrorViewComponent } from '../playlist-error-view/playlist-error-view.component';
import { PortalStore } from '../portal.store';

@Component({
    selector: 'app-category-view',
    template: `
        @if (items().length > 0) {
            @for (item of visibleItems(); track $index) {
                <mat-card
                    appearance="outlined"
                    class="category-item"
                    (click)="categoryClicked.emit(item)"
                >
                    <mat-card-content>
                        {{
                            item.category_name ||
                                $any(item).name ||
                                'No category name'
                        }}
                    </mat-card-content>
                </mat-card>
            }
            @if (!visibleItems().length) {
                <app-playlist-error-view
                    title="No results"
                    [description]="
                        'PORTALS.EMPTY_LIST_VIEW.NO_SEARCH_RESULTS' | translate
                    "
                    [showActionButtons]="false"
                    [viewType]="'NO_SEARCH_RESULTS'"
                />
            }
        } @else {
            <app-playlist-error-view
                [title]="'PORTALS.ERROR_VIEW.EMPTY_CATEGORY.TITLE' | translate"
                [description]="
                    'PORTALS.ERROR_VIEW.EMPTY_CATEGORY.DESCRIPTION' | translate
                "
                [showActionButtons]="false"
                [viewType]="'EMPTY_CATEGORY'"
            />
        }
    `,
    styleUrl: './category-view.component.scss',
    imports: [
        MatCardModule,
        MatIconModule,
        PlaylistErrorViewComponent,
        TranslatePipe,
    ],
})
export class CategoryViewComponent {
    readonly items = input.required<XtreamCategory[]>();

    readonly categoryClicked = output<XtreamCategory>();

    private readonly portalStore = inject(PortalStore);
    readonly searchPhrase = this.portalStore.searchPhrase;
    readonly sortType = this.portalStore.sortType;
    readonly visibleItems = computed(() => {
        const phrase = this.searchPhrase();
        const normalizedPhrase = (phrase ?? '').toLowerCase();

        const filtered = this.items().filter((item: any) => {
            const name = item.category_name || item.name || 'No category name';
            return name.toLowerCase().includes(normalizedPhrase);
        });

        if (this.sortType() === 'alpha') {
            return [...filtered].sort((a: any, b: any) => {
                const nameA = a.category_name || a.name || '';
                const nameB = b.category_name || b.name || '';
                return String(nameA).localeCompare(String(nameB), undefined, {
                    sensitivity: 'base',
                    numeric: true,
                });
            });
        }

        return filtered;
    });
}
