/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { i18n } from '@kbn/i18n';
import _ from 'lodash';
import { Observable, Subscription } from 'rxjs';
import { Moment } from 'moment';
import { History } from 'history';

import { DashboardContainer } from 'src/legacy/core_plugins/dashboard_embeddable_container/public/np_ready/public';
import { ViewMode } from '../../../../../../plugins/embeddable/public';
import { migrateLegacyQuery } from '../legacy_imports';
import {
  esFilters,
  Query,
  TimefilterContract as Timefilter,
} from '../../../../../../plugins/data/public';

import { getAppStateDefaults, migrateAppState } from './lib';
import { convertPanelStateToSavedDashboardPanel } from './lib/embeddable_saved_object_converters';
import { FilterUtils } from './lib/filter_utils';
import { SavedObjectDashboard } from '../saved_dashboard/saved_dashboard';

import {
  DashboardAppState,
  DashboardAppStateDefaults,
  DashboardAppStateTransitions,
  SavedDashboardPanel,
} from './types';
import {
  createStateContainer,
  IKbnUrlStateStorage,
  ISyncStateRef,
  ReduxLikeStateContainer,
  syncState,
} from '../../../../../../plugins/kibana_utils/public';

/**
 * Dashboard state manager handles connecting angular and redux state between the angular and react portions of the
 * app. There are two "sources of truth" that need to stay in sync - AppState (aka the `_a` portion of the url) and
 * the Store. They aren't complete duplicates of each other as AppState has state that the Store doesn't, and vice
 * versa. They should be as decoupled as possible so updating the store won't affect bwc of urls.
 */
export class DashboardStateManager {
  public savedDashboard: SavedObjectDashboard;
  public lastSavedDashboardFilters: {
    timeTo?: string | Moment;
    timeFrom?: string | Moment;
    filterBars: esFilters.Filter[];
    query: Query;
  };
  private stateDefaults: DashboardAppStateDefaults;
  private hideWriteControls: boolean;
  private kibanaVersion: string;
  public isDirty: boolean;
  private changeListeners: Array<(status: { dirty: boolean }) => void>;

  public get appState(): DashboardAppState {
    return this.stateContainer.get();
  }

  public get appState$(): Observable<DashboardAppState> {
    return this.stateContainer.state$;
  }

  private readonly stateContainer: ReduxLikeStateContainer<
    DashboardAppState,
    DashboardAppStateTransitions
  >;
  private readonly stateContainerChangeSub: Subscription;
  private readonly STATE_STORAGE_KEY = '_a';
  private readonly kbnUrlStateStorage: IKbnUrlStateStorage;
  private readonly stateSyncRef: ISyncStateRef;
  private readonly history: History;

  /**
   *
   * @param savedDashboard
   * @param hideWriteControls true if write controls should be hidden.
   * @param kibanaVersion current kibanaVersion
   * @param
   */
  constructor({
    savedDashboard,
    hideWriteControls,
    kibanaVersion,
    kbnUrlStateStorage,
    history,
  }: {
    savedDashboard: SavedObjectDashboard;
    hideWriteControls: boolean;
    kibanaVersion: string;
    kbnUrlStateStorage: IKbnUrlStateStorage;
    history: History;
  }) {
    this.history = history;
    this.kibanaVersion = kibanaVersion;
    this.savedDashboard = savedDashboard;
    this.hideWriteControls = hideWriteControls;

    // get state defaults from saved dashboard, make sure it is migrated
    this.stateDefaults = migrateAppState(
      getAppStateDefaults(this.savedDashboard, this.hideWriteControls),
      kibanaVersion
    );

    this.kbnUrlStateStorage = kbnUrlStateStorage;

    // setup initial state by merging defaults with state from url
    // also run migration, as state in url could be of older version
    const initialState = migrateAppState(
      {
        ...this.stateDefaults,
        ...this.kbnUrlStateStorage.get<DashboardAppState>(this.STATE_STORAGE_KEY),
      },
      kibanaVersion
    );

    // setup state container using initial state both from defaults and from url
    this.stateContainer = createStateContainer<DashboardAppState, DashboardAppStateTransitions>(
      initialState,
      {
        set: state => (prop, value) => ({ ...state, [prop]: value }),
        setOption: state => (option, value) => ({
          ...state,
          options: {
            ...state.options,
            [option]: value,
          },
        }),
      }
    );

    this.isDirty = false;

    // We can't compare the filters stored on this.appState to this.savedDashboard because in order to apply
    // the filters to the visualizations, we need to save it on the dashboard. We keep track of the original
    // filter state in order to let the user know if their filters changed and provide this specific information
    // in the 'lose changes' warning message.
    this.lastSavedDashboardFilters = this.getFilterState();

    this.changeListeners = [];

    this.stateContainerChangeSub = this.stateContainer.state$.subscribe(() => {
      this.isDirty = this.checkIsDirty();
      this.changeListeners.forEach(listener => listener({ dirty: this.isDirty }));
    });

    // make sure url ('_a') matches initial state
    this.kbnUrlStateStorage.set(this.STATE_STORAGE_KEY, initialState, { replace: true });

    // setup state syncing utils. state container will be synched with url into `this.STATE_STORAGE_KEY` query param
    this.stateSyncRef = syncState<DashboardAppState>({
      storageKey: this.STATE_STORAGE_KEY,
      stateContainer: {
        ...this.stateContainer,
        set: (state: DashboardAppState | null) => {
          // sync state required state container to be able to handle null
          // overriding set() so it could handle null coming from url
          this.stateContainer.set({
            ...this.stateDefaults,
            ...state,
          });
        },
      },
      stateStorage: this.kbnUrlStateStorage,
    });

    // actually start syncing state with container
    this.stateSyncRef.start();
  }

  public registerChangeListener(callback: (status: { dirty: boolean }) => void) {
    this.changeListeners.push(callback);
  }

  public handleDashboardContainerChanges(dashboardContainer: DashboardContainer) {
    let dirty = false;

    const savedDashboardPanelMap: { [key: string]: SavedDashboardPanel } = {};

    const input = dashboardContainer.getInput();
    this.getPanels().forEach(savedDashboardPanel => {
      if (input.panels[savedDashboardPanel.panelIndex] !== undefined) {
        savedDashboardPanelMap[savedDashboardPanel.panelIndex] = savedDashboardPanel;
      } else {
        // A panel was deleted.
        dirty = true;
      }
    });

    const convertedPanelStateMap: { [key: string]: SavedDashboardPanel } = {};

    Object.values(input.panels).forEach(panelState => {
      if (savedDashboardPanelMap[panelState.explicitInput.id] === undefined) {
        dirty = true;
      }

      convertedPanelStateMap[panelState.explicitInput.id] = convertPanelStateToSavedDashboardPanel(
        panelState,
        this.kibanaVersion
      );

      if (
        !_.isEqual(
          convertedPanelStateMap[panelState.explicitInput.id],
          savedDashboardPanelMap[panelState.explicitInput.id]
        )
      ) {
        // A panel was changed
        dirty = true;
      }
    });

    if (dirty) {
      this.stateContainer.transitions.set('panels', Object.values(convertedPanelStateMap));
    }

    if (input.isFullScreenMode !== this.getFullScreenMode()) {
      this.setFullScreenMode(input.isFullScreenMode);
    }

    if (!_.isEqual(input.query, this.getQuery())) {
      this.setQuery(input.query);
    }

    this.changeListeners.forEach(listener => listener({ dirty }));
  }

  public getFullScreenMode() {
    return this.appState.fullScreenMode;
  }

  public setFullScreenMode(fullScreenMode: boolean) {
    this.stateContainer.transitions.set('fullScreenMode', fullScreenMode);
  }

  public setFilters(filters: esFilters.Filter[]) {
    this.stateContainer.transitions.set('filters', filters);
  }

  /**
   * Resets the state back to the last saved version of the dashboard.
   */
  public resetState() {
    // In order to show the correct warning, we have to store the unsaved
    // title on the dashboard object. We should fix this at some point, but this is how all the other object
    // save panels work at the moment.
    this.savedDashboard.title = this.savedDashboard.lastSavedTitle;

    // appState.reset uses the internal defaults to reset the state, but some of the default settings (e.g. the panels
    // array) point to the same object that is stored on appState and is getting modified.
    // The right way to fix this might be to ensure the defaults object stored on state is a deep
    // clone, but given how much code uses the state object, I determined that to be too risky of a change for
    // now.  TODO: revisit this!
    this.stateDefaults = migrateAppState(
      getAppStateDefaults(this.savedDashboard, this.hideWriteControls),
      this.kibanaVersion
    );
    // The original query won't be restored by the above because the query on this.savedDashboard is applied
    // in place in order for it to affect the visualizations.
    this.stateDefaults.query = this.lastSavedDashboardFilters.query;
    // Need to make a copy to ensure they are not overwritten.
    this.stateDefaults.filters = [...this.getLastSavedFilterBars()];

    this.isDirty = false;
    this.stateContainer.set(this.stateDefaults);
  }

  /**
   * Returns an object which contains the current filter state of this.savedDashboard.
   */
  public getFilterState() {
    return {
      timeTo: this.savedDashboard.timeTo,
      timeFrom: this.savedDashboard.timeFrom,
      filterBars: this.savedDashboard.getFilters(),
      query: this.savedDashboard.getQuery(),
    };
  }

  public getTitle() {
    return this.appState.title;
  }

  public isSaved() {
    return !!this.savedDashboard.id;
  }

  public isNew() {
    return !this.isSaved();
  }

  public getDescription() {
    return this.appState.description;
  }

  public setDescription(description: string) {
    this.stateContainer.transitions.set('description', description);
  }

  public setTitle(title: string) {
    this.savedDashboard.title = title;
    this.stateContainer.transitions.set('title', title);
  }

  public getAppState() {
    return this.stateContainer.get();
  }

  public getQuery(): Query {
    return migrateLegacyQuery(this.stateContainer.get().query);
  }

  public getSavedQueryId() {
    return this.stateContainer.get().savedQuery;
  }

  public setSavedQueryId(id?: string) {
    this.stateContainer.transitions.set('savedQuery', id);
  }

  public getUseMargins() {
    // Existing dashboards that don't define this should default to false.
    return this.appState.options.useMargins === undefined
      ? false
      : this.appState.options.useMargins;
  }

  public setUseMargins(useMargins: boolean) {
    this.stateContainer.transitions.setOption('useMargins', useMargins);
  }

  public getHidePanelTitles() {
    return this.appState.options.hidePanelTitles;
  }

  public setHidePanelTitles(hidePanelTitles: boolean) {
    this.stateContainer.transitions.setOption('hidePanelTitles', hidePanelTitles);
  }

  public getTimeRestore() {
    return this.appState.timeRestore;
  }

  public setTimeRestore(timeRestore: boolean) {
    this.stateContainer.transitions.set('timeRestore', timeRestore);
  }

  public getIsTimeSavedWithDashboard() {
    return this.savedDashboard.timeRestore;
  }

  public getLastSavedFilterBars(): esFilters.Filter[] {
    return this.lastSavedDashboardFilters.filterBars;
  }

  public getLastSavedQuery() {
    return this.lastSavedDashboardFilters.query;
  }

  /**
   * @returns True if the query changed since the last time the dashboard was saved, or if it's a
   * new dashboard, if the query differs from the default.
   */
  public getQueryChanged() {
    const currentQuery = this.appState.query;
    const lastSavedQuery = this.getLastSavedQuery();

    const query = migrateLegacyQuery(currentQuery);

    const isLegacyStringQuery =
      _.isString(lastSavedQuery) && _.isPlainObject(currentQuery) && _.has(currentQuery, 'query');
    if (isLegacyStringQuery) {
      return lastSavedQuery !== query.query;
    }

    return !_.isEqual(currentQuery, lastSavedQuery);
  }

  /**
   * @returns True if the filter bar state has changed since the last time the dashboard was saved,
   * or if it's a new dashboard, if the query differs from the default.
   */
  public getFilterBarChanged() {
    return !_.isEqual(
      FilterUtils.cleanFiltersForComparison(this.appState.filters),
      FilterUtils.cleanFiltersForComparison(this.getLastSavedFilterBars())
    );
  }

  /**
   * @param timeFilter
   * @returns True if the time state has changed since the time saved with the dashboard.
   */
  public getTimeChanged(timeFilter: Timefilter) {
    return (
      !FilterUtils.areTimesEqual(
        this.lastSavedDashboardFilters.timeFrom,
        timeFilter.getTime().from
      ) ||
      !FilterUtils.areTimesEqual(this.lastSavedDashboardFilters.timeTo, timeFilter.getTime().to)
    );
  }

  public getViewMode() {
    return this.hideWriteControls ? ViewMode.VIEW : this.appState.viewMode;
  }

  public getIsViewMode() {
    return this.getViewMode() === ViewMode.VIEW;
  }

  public getIsEditMode() {
    return this.getViewMode() === ViewMode.EDIT;
  }

  /**
   *
   * @returns True if the dashboard has changed since the last save (or, is new).
   */
  public getIsDirty(timeFilter?: Timefilter) {
    // Filter bar comparison is done manually (see cleanFiltersForComparison for the reason) and time picker
    // changes are not tracked by the state monitor.
    const hasTimeFilterChanged = timeFilter ? this.getFiltersChanged(timeFilter) : false;
    return this.getIsEditMode() && (this.isDirty || hasTimeFilterChanged);
  }

  public getPanels(): SavedDashboardPanel[] {
    return this.appState.panels;
  }

  public updatePanel(panelIndex: string, panelAttributes: any) {
    const foundPanel = this.getPanels().find(
      (panel: SavedDashboardPanel) => panel.panelIndex === panelIndex
    );
    Object.assign(foundPanel, panelAttributes);
    return foundPanel;
  }

  /**
   * @param timeFilter
   * @returns An array of user friendly strings indicating the filter types that have changed.
   */
  public getChangedFilterTypes(timeFilter: Timefilter) {
    const changedFilters = [];
    if (this.getFilterBarChanged()) {
      changedFilters.push('filter');
    }
    if (this.getQueryChanged()) {
      changedFilters.push('query');
    }
    if (this.savedDashboard.timeRestore && this.getTimeChanged(timeFilter)) {
      changedFilters.push('time range');
    }
    return changedFilters;
  }

  /**
   * @returns True if filters (query, filter bar filters, and time picker if time is stored
   * with the dashboard) have changed since the last saved state (or if the dashboard hasn't been saved,
   * the default state).
   */
  public getFiltersChanged(timeFilter: Timefilter) {
    return this.getChangedFilterTypes(timeFilter).length > 0;
  }

  /**
   * Updates timeFilter to match the time saved with the dashboard.
   * @param timeFilter
   * @param timeFilter.setTime
   * @param timeFilter.setRefreshInterval
   */
  public syncTimefilterWithDashboard(timeFilter: Timefilter) {
    if (!this.getIsTimeSavedWithDashboard()) {
      throw new Error(
        i18n.translate('kbn.dashboard.stateManager.timeNotSavedWithDashboardErrorMessage', {
          defaultMessage: 'The time is not saved with this dashboard so should not be synced.',
        })
      );
    }

    if (this.savedDashboard.timeFrom && this.savedDashboard.timeTo) {
      timeFilter.setTime({
        from: this.savedDashboard.timeFrom,
        to: this.savedDashboard.timeTo,
      });
    }

    if (this.savedDashboard.refreshInterval) {
      timeFilter.setRefreshInterval(this.savedDashboard.refreshInterval);
    }
  }

  /**
   * Synchronously writes current state to url
   * returned boolean indicates whether the update happened and if history was updated
   */
  private saveState({ replace }: { replace: boolean }): boolean {
    // schedules setting current state to url
    this.kbnUrlStateStorage.set<DashboardAppState>(
      this.STATE_STORAGE_KEY,
      this.stateContainer.get()
    );
    // immediately forces scheduled updates and changes location
    return this.kbnUrlStateStorage.flush({ replace });
  }

  // TODO: find nicer solution for this
  // this function helps to make just 1 browser history update, when we imperatively changing the dashboard url
  // It could be that there is pending *dashboardStateManager* updates, which aren't flushed yet to the url.
  // So to prevent 2 browser updates:
  // 1. Force flush any pending state updates (syncing state to query)
  // 2. If url was updated, then apply path change with replace
  public changeDashboardUrl(pathname: string) {
    // synchronously persist current state to url with push()
    const updated = this.saveState({ replace: false });
    // change pathname
    this.history[updated ? 'replace' : 'push']({
      ...this.history.location,
      pathname,
    });
  }

  public setQuery(query: Query) {
    this.stateContainer.transitions.set('query', query);
  }

  /**
   * Applies the current filter state to the dashboard.
   * @param filter An array of filter bar filters.
   */
  public applyFilters(query: Query, filters: esFilters.Filter[]) {
    this.savedDashboard.searchSource.setField('query', query);
    this.savedDashboard.searchSource.setField('filter', filters);
    this.stateContainer.transitions.set('query', query);
  }

  public switchViewMode(newMode: ViewMode) {
    this.stateContainer.transitions.set('viewMode', newMode);
  }

  /**
   * Destroys and cleans up this object when it's no longer used.
   */
  public destroy() {
    this.stateContainerChangeSub.unsubscribe();
    this.savedDashboard.destroy();
    if (this.stateSyncRef) {
      this.stateSyncRef.stop();
    }
  }

  private checkIsDirty() {
    // Filters need to be compared manually because they sometimes have a $$hashkey stored on the object.
    // Query needs to be compared manually because saved legacy queries get migrated in app state automatically
    const propsToIgnore: Array<keyof DashboardAppState> = ['viewMode', 'filters', 'query'];

    const initial = _.omit(this.stateDefaults, propsToIgnore);
    const current = _.omit(this.stateContainer.get(), propsToIgnore);
    return !_.isEqual(initial, current);
  }
}