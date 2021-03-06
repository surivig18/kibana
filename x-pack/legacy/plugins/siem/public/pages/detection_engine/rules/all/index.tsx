/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { EuiBasicTable, EuiContextMenuPanel, EuiLoadingContent, EuiSpacer } from '@elastic/eui';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import uuid from 'uuid';

import {
  useRules,
  useRulesStatuses,
  CreatePreBuiltRules,
  FilterOptions,
  Rule,
  PaginationOptions,
  exportRules,
} from '../../../../containers/detection_engine/rules';
import { HeaderSection } from '../../../../components/header_section';
import {
  UtilityBar,
  UtilityBarAction,
  UtilityBarGroup,
  UtilityBarSection,
  UtilityBarText,
} from '../../../../components/utility_bar';
import { useStateToaster } from '../../../../components/toasters';
import { Loader } from '../../../../components/loader';
import { Panel } from '../../../../components/panel';
import { PrePackagedRulesPrompt } from '../components/pre_packaged_rules/load_empty_prompt';
import { GenericDownloader } from '../../../../components/generic_downloader';
import { AllRulesTables } from '../components/all_rules_tables';
import { getPrePackagedRuleStatus } from '../helpers';
import * as i18n from '../translations';
import { EuiBasicTableOnChange } from '../types';
import { getBatchItems } from './batch_actions';
import { getColumns, getMonitoringColumns } from './columns';
import { showRulesTable } from './helpers';
import { allRulesReducer, State } from './reducer';
import { RulesTableFilters } from './rules_table_filters/rules_table_filters';

const initialState: State = {
  exportRuleIds: [],
  filterOptions: {
    filter: '',
    sortField: 'enabled',
    sortOrder: 'desc',
  },
  loadingRuleIds: [],
  loadingRulesAction: null,
  pagination: {
    page: 1,
    perPage: 20,
    total: 0,
  },
  rules: [],
  selectedRuleIds: [],
};

interface AllRulesProps {
  createPrePackagedRules: CreatePreBuiltRules | null;
  hasNoPermissions: boolean;
  loading: boolean;
  loadingCreatePrePackagedRules: boolean;
  refetchPrePackagedRulesStatus: () => void;
  rulesCustomInstalled: number | null;
  rulesInstalled: number | null;
  rulesNotInstalled: number | null;
  rulesNotUpdated: number | null;
  setRefreshRulesData: (refreshRule: (refreshPrePackagedRule?: boolean) => void) => void;
}

/**
 * Table Component for displaying all Rules for a given cluster. Provides the ability to filter
 * by name, sort by enabled, and perform the following actions:
 *   * Enable/Disable
 *   * Duplicate
 *   * Delete
 *   * Import/Export
 */
export const AllRules = React.memo<AllRulesProps>(
  ({
    createPrePackagedRules,
    hasNoPermissions,
    loading,
    loadingCreatePrePackagedRules,
    refetchPrePackagedRulesStatus,
    rulesCustomInstalled,
    rulesInstalled,
    rulesNotInstalled,
    rulesNotUpdated,
    setRefreshRulesData,
  }) => {
    const [initLoading, setInitLoading] = useState(true);
    const tableRef = useRef<EuiBasicTable>();
    const [
      {
        exportRuleIds,
        filterOptions,
        loadingRuleIds,
        loadingRulesAction,
        pagination,
        rules,
        selectedRuleIds,
      },
      dispatch,
    ] = useReducer(allRulesReducer(tableRef), initialState);
    const { loading: isLoadingRulesStatuses, rulesStatuses } = useRulesStatuses(rules);
    const history = useHistory();
    const [, dispatchToaster] = useStateToaster();

    const setRules = useCallback((newRules: Rule[], newPagination: Partial<PaginationOptions>) => {
      dispatch({
        type: 'setRules',
        rules: newRules,
        pagination: newPagination,
      });
    }, []);

    const [isLoadingRules, , reFetchRulesData] = useRules({
      pagination,
      filterOptions,
      refetchPrePackagedRulesStatus,
      dispatchRulesInReducer: setRules,
    });

    const sorting = useMemo(
      () => ({
        sort: { field: 'enabled', direction: filterOptions.sortOrder },
      }),
      [filterOptions.sortOrder]
    );

    const prePackagedRuleStatus = getPrePackagedRuleStatus(
      rulesInstalled,
      rulesNotInstalled,
      rulesNotUpdated
    );

    const getBatchItemsPopoverContent = useCallback(
      (closePopover: () => void) => (
        <EuiContextMenuPanel
          items={getBatchItems({
            closePopover,
            dispatch,
            dispatchToaster,
            loadingRuleIds,
            selectedRuleIds,
            reFetchRules: reFetchRulesData,
            rules,
          })}
        />
      ),
      [dispatch, dispatchToaster, loadingRuleIds, reFetchRulesData, rules, selectedRuleIds]
    );

    const paginationMemo = useMemo(
      () => ({
        pageIndex: pagination.page - 1,
        pageSize: pagination.perPage,
        totalItemCount: pagination.total,
        pageSizeOptions: [5, 10, 20, 50, 100, 200, 300],
      }),
      [pagination]
    );

    const tableOnChangeCallback = useCallback(
      ({ page, sort }: EuiBasicTableOnChange) => {
        dispatch({
          type: 'updateFilterOptions',
          filterOptions: {
            sortField: 'enabled', // Only enabled is supported for sorting currently
            sortOrder: sort?.direction ?? 'desc',
          },
          pagination: { page: page.index + 1, perPage: page.size },
        });
      },
      [dispatch]
    );

    const rulesColumns = useMemo(() => {
      return getColumns({
        dispatch,
        dispatchToaster,
        history,
        hasNoPermissions,
        loadingRuleIds:
          loadingRulesAction != null &&
          (loadingRulesAction === 'enable' || loadingRulesAction === 'disable')
            ? loadingRuleIds
            : [],
        reFetchRules: reFetchRulesData,
      });
    }, [dispatch, dispatchToaster, history, loadingRuleIds, loadingRulesAction, reFetchRulesData]);

    const monitoringColumns = useMemo(() => getMonitoringColumns(), []);

    useEffect(() => {
      if (reFetchRulesData != null) {
        setRefreshRulesData(reFetchRulesData);
      }
    }, [reFetchRulesData, setRefreshRulesData]);

    useEffect(() => {
      if (initLoading && !loading && !isLoadingRules && !isLoadingRulesStatuses) {
        setInitLoading(false);
      }
    }, [initLoading, loading, isLoadingRules, isLoadingRulesStatuses]);

    const handleCreatePrePackagedRules = useCallback(async () => {
      if (createPrePackagedRules != null && reFetchRulesData != null) {
        await createPrePackagedRules();
        reFetchRulesData(true);
      }
    }, [createPrePackagedRules, reFetchRulesData]);

    const euiBasicTableSelectionProps = useMemo(
      () => ({
        selectable: (item: Rule) => !loadingRuleIds.includes(item.id),
        onSelectionChange: (selected: Rule[]) =>
          dispatch({ type: 'selectedRuleIds', ids: selected.map(r => r.id) }),
      }),
      [loadingRuleIds]
    );

    const onFilterChangedCallback = useCallback((newFilterOptions: Partial<FilterOptions>) => {
      dispatch({
        type: 'updateFilterOptions',
        filterOptions: {
          ...newFilterOptions,
        },
        pagination: { page: 1 },
      });
    }, []);

    const isLoadingAnActionOnRule = useMemo(() => {
      if (
        loadingRuleIds.length > 0 &&
        (loadingRulesAction === 'disable' || loadingRulesAction === 'enable')
      ) {
        return false;
      } else if (loadingRuleIds.length > 0) {
        return true;
      }
      return false;
    }, [loadingRuleIds, loadingRulesAction]);

    return (
      <>
        <GenericDownloader
          filename={`${i18n.EXPORT_FILENAME}.ndjson`}
          ids={exportRuleIds}
          onExportSuccess={exportCount => {
            dispatch({ type: 'loadingRuleIds', ids: [], actionType: null });
            dispatchToaster({
              type: 'addToaster',
              toast: {
                id: uuid.v4(),
                title: i18n.SUCCESSFULLY_EXPORTED_RULES(exportCount),
                color: 'success',
                iconType: 'check',
              },
            });
          }}
          exportSelectedData={exportRules}
        />
        <EuiSpacer />

        <Panel loading={loading || isLoadingRules || isLoadingRulesStatuses}>
          <>
            <HeaderSection split title={i18n.ALL_RULES}>
              <RulesTableFilters
                onFilterChanged={onFilterChangedCallback}
                rulesCustomInstalled={rulesCustomInstalled}
                rulesInstalled={rulesInstalled}
              />
            </HeaderSection>

            {(loading || isLoadingRules || isLoadingAnActionOnRule || isLoadingRulesStatuses) &&
              !initLoading && (
                <Loader data-test-subj="loadingPanelAllRulesTable" overlay size="xl" />
              )}
            {rulesCustomInstalled != null &&
              rulesCustomInstalled === 0 &&
              prePackagedRuleStatus === 'ruleNotInstalled' &&
              !initLoading && (
                <PrePackagedRulesPrompt
                  createPrePackagedRules={handleCreatePrePackagedRules}
                  loading={loadingCreatePrePackagedRules}
                  userHasNoPermissions={hasNoPermissions}
                />
              )}
            {initLoading && (
              <EuiLoadingContent data-test-subj="initialLoadingPanelAllRulesTable" lines={10} />
            )}
            {showRulesTable({ rulesCustomInstalled, rulesInstalled }) && !initLoading && (
              <>
                <UtilityBar border>
                  <UtilityBarSection>
                    <UtilityBarGroup>
                      <UtilityBarText dataTestSubj="showingRules">
                        {i18n.SHOWING_RULES(pagination.total ?? 0)}
                      </UtilityBarText>
                    </UtilityBarGroup>

                    <UtilityBarGroup>
                      <UtilityBarText>{i18n.SELECTED_RULES(selectedRuleIds.length)}</UtilityBarText>
                      {!hasNoPermissions && (
                        <UtilityBarAction
                          dataTestSubj="bulkActions"
                          iconSide="right"
                          iconType="arrowDown"
                          popoverContent={getBatchItemsPopoverContent}
                        >
                          {i18n.BATCH_ACTIONS}
                        </UtilityBarAction>
                      )}
                      <UtilityBarAction
                        iconSide="left"
                        iconType="refresh"
                        onClick={() => reFetchRulesData(true)}
                      >
                        {i18n.REFRESH}
                      </UtilityBarAction>
                    </UtilityBarGroup>
                  </UtilityBarSection>
                </UtilityBar>
                <AllRulesTables
                  euiBasicTableSelectionProps={euiBasicTableSelectionProps}
                  hasNoPermissions={hasNoPermissions}
                  monitoringColumns={monitoringColumns}
                  paginationMemo={paginationMemo}
                  rules={rules}
                  rulesColumns={rulesColumns}
                  rulesStatuses={rulesStatuses}
                  sorting={sorting}
                  tableOnChangeCallback={tableOnChangeCallback}
                  tableRef={tableRef}
                />
              </>
            )}
          </>
        </Panel>
      </>
    );
  }
);

AllRules.displayName = 'AllRules';
