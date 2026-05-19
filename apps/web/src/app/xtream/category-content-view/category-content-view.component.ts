import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FilterPipe, SortPipe } from '@iptvmate/pipes';
import { TranslateModule } from '@ngx-translate/core';
import { XtreamItem } from 'shared-interfaces';
import { PlaylistErrorViewComponent } from '../playlist-error-view/playlist-error-view.component';
import { PortalStore } from '../portal.store';

@Component({
    selector: 'app-category-content-view',
    templateUrl: './category-content-view.component.html',
    styleUrls: ['./category-content-view.component.scss'],
    imports: [
        FilterPipe,
        SortPipe,
        MatCardModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatTooltipModule,
        PlaylistErrorViewComponent,
        TranslateModule,
        FormsModule,
    ],
})
export class CategoryContentViewComponent {
    @Input({ required: true }) items: XtreamItem[];
    @Output() itemClicked = new EventEmitter<XtreamItem>();

    portalStore = inject(PortalStore);
    searchPhrase = this.portalStore.searchPhrase;
    sortType = this.portalStore.sortType;

    onSearchChange(value: string): void {
        this.portalStore.setSearchPhrase(value);
    }
}
