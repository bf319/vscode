/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import 'vs/css!./media/bookmarkIcon';
import * as DOM from 'vs/base/browser/dom';
import { URI } from 'vs/base/common/uri';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ViewPane } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IBookmarksManager, BookmarkType, SortType } from 'vs/workbench/contrib/scopeTree/common/bookmarks';
import { Codicon } from 'vs/base/common/codicons';
import { basename } from 'vs/base/common/resources';
import { IExplorerService } from 'vs/workbench/contrib/files/common/files';
import { IListVirtualDelegate, IKeyboardNavigationLabelProvider } from 'vs/base/browser/ui/list/list';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import { IDisposable, Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { WorkbenchObjectTree } from 'vs/platform/list/browser/listService';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { ITreeRenderer, ITreeNode, ITreeElement, ITreeContextMenuEvent } from 'vs/base/browser/ui/tree/tree';
import { ResourceLabels } from 'vs/workbench/browser/labels';
import { IAction } from 'vs/base/common/actions';
import { createAndFillInContextMenuActions } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IMenu, IMenuService, MenuId } from 'vs/platform/actions/common/actions';
import { Directory, IDirectoryTemplateData, DirectoryElementIconRenderer, DirectoryRenderer } from 'vs/workbench/contrib/scopeTree/browser/directoryViewer';

export class BookmarkHeader {
	expanded: boolean = true;

	constructor(readonly scope: BookmarkType) { }
}

class BookmarkDelegate implements IListVirtualDelegate<Directory | BookmarkHeader> {
	static readonly ITEM_HEIGHT = 22;

	getHeight(element: Directory | BookmarkHeader): number {
		return BookmarkDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: Directory | BookmarkHeader): string {
		if (element instanceof Directory) {
			return BookmarkRenderer.ID;
		}

		return BookmarkHeaderRenderer.ID;
	}
}

interface IBookmarkHeaderTemplateData {
	headerContainer: HTMLElement;
	elementDisposable: IDisposable;
}

class BookmarkRenderer extends DirectoryRenderer {
	static readonly ID = 'BookmarkRenderer';

	get templateId() {
		return BookmarkRenderer.ID;
	}

	renderElement(element: ITreeNode<Directory, FuzzyScore>, index: number, templateData: IDirectoryTemplateData, height: number | undefined): void {
		templateData.elementDisposable.dispose();
		templateData.elementDisposable = this.renderBookmark(element.element, templateData, element.filterData);
	}

	private renderBookmark(bookmark: Directory, templateData: IDirectoryTemplateData, filterData: FuzzyScore | undefined): IDisposable {
		templateData.label.setResource({
			resource: bookmark.resource,
			name: bookmark.getName(),
			description: bookmark.getParent()
		}, {
			matches: createMatches(filterData)
		});

		return new DirectoryElementIconRenderer(templateData.label.element, bookmark.resource, this.explorerService);
	}
}

class BookmarkHeaderRenderer implements ITreeRenderer<BookmarkHeader, FuzzyScore, IBookmarkHeaderTemplateData>{
	static readonly ID = 'BookmarkHeaderRenderer';

	get templateId() {
		return BookmarkHeaderRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IBookmarkHeaderTemplateData {
		return { headerContainer: container, elementDisposable: Disposable.None };
	}

	renderElement(element: ITreeNode<BookmarkHeader, FuzzyScore>, index: number, templateData: IBookmarkHeaderTemplateData, height: number | undefined): void {
		templateData.elementDisposable.dispose();
		templateData.elementDisposable = this.renderBookmarksHeader(element.element, templateData.headerContainer);
	}

	disposeTemplate(templateData: IBookmarkHeaderTemplateData): void {
		templateData.elementDisposable.dispose();
	}

	private renderBookmarksHeader(element: BookmarkHeader, container: HTMLElement): IDisposable {
		const scope = element.scope;
		const header = DOM.append(container, document.createElement('div'));
		header.className = 'bookmark-header';

		const collapsedTwistie = DOM.$(Codicon.chevronRight.cssSelector);
		collapsedTwistie.style.paddingTop = '2px';
		const expandedTwistie = DOM.$(Codicon.chevronDown.cssSelector);
		expandedTwistie.style.paddingTop = '2px';

		if (element.expanded) {
			header.appendChild(expandedTwistie);
		} else {
			header.appendChild(collapsedTwistie);
		}

		const scopeIcon = DOM.append(header, document.createElement('img'));
		scopeIcon.className = scope === BookmarkType.WORKSPACE ? 'bookmark-header-workspace-icon' : 'bookmark-header-global-icon';

		const containerTitle = DOM.append(header, document.createElement('span'));
		containerTitle.innerText = scope === BookmarkType.WORKSPACE ? 'WORKSPACE BOOKMARKS' : 'GLOBAL BOOKMARKS';

		// Toggle twistie icon
		header.onclick = () => {
			if (expandedTwistie.parentElement) {
				header.replaceChild(collapsedTwistie, expandedTwistie);
			} else {
				header.replaceChild(expandedTwistie, collapsedTwistie);
			}
		};

		return {
			dispose(): void {
				header.remove();
			}
		};
	}
}

export class BookmarksView extends ViewPane {
	static readonly ID: string = 'workbench.explorer.displayBookmarksView';
	static readonly NAME = 'Bookmarks';

	private labels!: ResourceLabels;
	private tree!: WorkbenchObjectTree<Directory | BookmarkHeader, FuzzyScore>;

	private globalBookmarksHeader = new BookmarkHeader(BookmarkType.GLOBAL);
	private workspaceBookmarksHeader = new BookmarkHeader(BookmarkType.WORKSPACE);

	private globalBookmarks: ITreeElement<Directory>[] = [];
	private workspaceBookmarks: ITreeElement<Directory>[] = [];

	private contributedContextMenu!: IMenu;

	private sortType: SortType = SortType.NAME;

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IBookmarksManager private readonly bookmarksManager: IBookmarksManager,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IMenuService private readonly menuService: IMenuService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService);

		this.labels = this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility });
		this._register(this.bookmarksManager.onBookmarksChanged(e => {
			const resource = e.uri;
			const prevScope = e.prevBookmarkType;
			const newScope = e.bookmarkType;

			if (newScope !== prevScope) {
				this.removeBookmark(resource, prevScope);
				this.renderNewBookmark(resource, newScope);
			}
		}));

		this._register(this.bookmarksManager.onDidSortBookmark(sortType => {
			this.sortType = sortType;
			this.sortAndRefresh(sortType);
		}));
	}

	protected renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.tree = this.createTree(container);
		this._register(this.tree);

		this.tree.setChildren(null, [{ element: this.globalBookmarksHeader }, { element: this.workspaceBookmarksHeader }]);
		this.sortAndRefresh(this.sortType);

		this._register(this.tree.onMouseClick(e => {
			if (e.element instanceof BookmarkHeader) {
				this.toggleHeader(e.element);
			}
		}));

		this.contributedContextMenu = this.menuService.createMenu(MenuId.DisplayBookmarksContext, this.tree.contextKeyService);
		this.tree.onContextMenu(e => this.onContextMenu(e));
	}

	protected layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree.layout(height, width);
	}

	private sortAndRefresh(sortType: SortType) {
		this.globalBookmarks = this.getBookmarksTreeElements(this.bookmarksManager.globalBookmarks, sortType);
		this.workspaceBookmarks = this.getBookmarksTreeElements(this.bookmarksManager.workspaceBookmarks, sortType);

		this.tree.setChildren(this.globalBookmarksHeader, this.globalBookmarks);
		this.tree.setChildren(this.workspaceBookmarksHeader, this.workspaceBookmarks);
	}

	private createTree(container: HTMLElement): WorkbenchObjectTree<Directory | BookmarkHeader, FuzzyScore> {
		return <WorkbenchObjectTree<Directory | BookmarkHeader, FuzzyScore>>this.instantiationService.createInstance(
			WorkbenchObjectTree,
			'BookmarksPane',
			container,
			new BookmarkDelegate(),
			[new BookmarkRenderer(this.labels, this.explorerService), new BookmarkHeaderRenderer()],
			{
				accessibilityProvider: {
					getAriaLabel(element: Directory | BookmarkHeader): string {
						if (element instanceof Directory) {
							return element.resource.toString();
						}

						return 'Bookmark header';
					},
					getWidgetAriaLabel(): string {
						return 'Bookmarks panel';
					}
				},
				verticalScrollMode: ScrollbarVisibility.Auto,
				keyboardNavigationLabelProvider: new BookmarkKeyboardNavigationLabelProvider()
			});
	}

	private onContextMenu(e: ITreeContextMenuEvent<Directory | BookmarkHeader | null>): void {
		if (!e.element) {
			return;
		}

		const actions: IAction[] = [];
		const disposables = new DisposableStore();
		disposables.add(createAndFillInContextMenuActions(this.contributedContextMenu, { shouldForwardArgs: true }, actions, this.contextMenuService));

		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => actions,
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree.domFocus();
				}
				disposables.dispose();
			},
			getActionsContext: () => e.element
		});
	}

	private sortBookmarksByName(bookmarks: ITreeElement<Directory>[]): ITreeElement<Directory>[] {
		return bookmarks.sort((bookmark1, bookmark2) => {
			const compareNames = bookmark1.element.getName().localeCompare(bookmark2.element.getName());

			// If directories have the same name, compare them by their full path
			return compareNames || bookmark1.element.getParent().localeCompare(bookmark2.element.getParent());
		});
	}

	private sortBookmarksByDate(bookmarks: ITreeElement<Directory>[]): ITreeElement<Directory>[] {
		// Order has to be revesed when bookmarks are sorted by date because bookmarksManager keeps the most recent at the end of the array
		return bookmarks.reverse();
	}

	private getBookmarksTreeElements(rawBookmarks: Set<string>, sortType: SortType): ITreeElement<Directory>[] {
		const unsortedTreeElements: ITreeElement<Directory>[] = [];
		rawBookmarks.forEach(bookmark => {
			unsortedTreeElements.push({
				element: new Directory(bookmark)
			});
		});
		return sortType === SortType.NAME ? this.sortBookmarksByName(unsortedTreeElements) : this.sortBookmarksByDate(unsortedTreeElements);
	}

	private toggleHeader(header: BookmarkHeader) {
		header.expanded = !header.expanded;
		const headerItem = header.scope === BookmarkType.GLOBAL ? this.globalBookmarksHeader : this.workspaceBookmarksHeader;
		const children = header.expanded ? (header.scope === BookmarkType.GLOBAL ? this.globalBookmarks : this.workspaceBookmarks) : [];

		this.tree.setChildren(headerItem, children);
	}

	private renderNewBookmark(resource: URI, scope: BookmarkType): void {
		const resourceAsString = resource.toString();
		const resourceIndex = this.sortType === SortType.DATE ? 0 : this.findIndexInSortedArray(basename(resource), scope);
		if (scope === BookmarkType.NONE) {
			return;
		}

		if (scope === BookmarkType.WORKSPACE) {
			this.workspaceBookmarks.splice(resourceIndex, 0, { element: new Directory(resourceAsString) });
			if (this.workspaceBookmarksHeader.expanded) {
				this.tree.setChildren(this.workspaceBookmarksHeader, this.workspaceBookmarks);
			}
		}

		if (scope === BookmarkType.GLOBAL) {
			this.globalBookmarks.splice(resourceIndex, 0, { element: new Directory(resourceAsString) });
			if (this.globalBookmarksHeader.expanded) {
				this.tree.setChildren(this.globalBookmarksHeader, this.globalBookmarks);
			}
		}
	}

	private removeBookmark(resource: URI, prevType: BookmarkType): void {
		if (prevType === BookmarkType.WORKSPACE) {
			this.workspaceBookmarks = this.workspaceBookmarks.filter(e => e.element.resource.toString() !== resource.toString());
			if (this.workspaceBookmarksHeader.expanded) {
				this.tree.setChildren(this.workspaceBookmarksHeader, this.workspaceBookmarks);
			}
		}

		if (prevType === BookmarkType.GLOBAL) {
			this.globalBookmarks = this.globalBookmarks.filter(e => e.element.resource.toString() !== resource.toString());
			if (this.globalBookmarksHeader.expanded) {
				this.tree.setChildren(this.globalBookmarksHeader, this.globalBookmarks);
			}
		}
	}

	private findIndexInSortedArray(resource: string, scope: BookmarkType) {
		// Assuming that the bookmarks array is sorted by name, find the index for this resource using a binary search
		const bookmarks = scope === BookmarkType.WORKSPACE ? this.workspaceBookmarks : this.globalBookmarks;
		let left = 0;
		let right = bookmarks.length;

		while (left < right) {
			const mid = (left + right) >>> 1;
			if (bookmarks[mid].element.getName() < resource) {
				left = mid + 1;
			} else {
				right = mid;
			}
		}

		return left;
	}
}

class BookmarkKeyboardNavigationLabelProvider implements IKeyboardNavigationLabelProvider<Directory | BookmarkHeader> {
	getKeyboardNavigationLabel(element: Directory | BookmarkHeader): string | undefined {
		if (element instanceof Directory) {
			return element.getName();
		}

		return undefined;
	}
}
