import { AppProps, I18nProps } from '@polkadot/react-components/types';
import { ApiProps } from '@polkadot/react-api/types';
import { SubjectInfo } from '@polkadot/ui-keyring/observable/types';
import { ComponentProps } from './props';
import { Request, Role } from '@joystream/types/roles';

import React from 'react';
import { Route, Switch } from 'react-router';
import { AccountId } from '@polkadot/types/interfaces';
import Tabs, { TabItem } from '@polkadot/react-components/Tabs';
import accountObservable from '@polkadot/ui-keyring/observable/accounts';
import { withCalls, withMulti, withObservable } from '@polkadot/react-api/index';

import ActorsList from './ActorsList';
import MyRequests from './MyRequests';
import AvailableRoles from './AvailableRoles';

import './index.sass';

import translate from './translate';

type Props = AppProps & ApiProps & I18nProps & {
  requests?: Array<Request>,
  actorAccountIds?: Array<AccountId>,
  roles?: Array<Role>,
  allAccounts?: SubjectInfo,
};

type State = {
  tabs: Array<TabItem>,
  actorAccountIds: Array<string>,
  requests: Array<Request>,
  roles: Array<Role>,
};

class App extends React.PureComponent<Props, State> {
  state: State;

  constructor (props: Props) {
    super(props);

    const { t } = props;

    this.state = {
      actorAccountIds: [],
      requests: [],
      roles: [],
      tabs: [
        {
          isRoot: true,
          name: 'working-groups',
          text: t('Working groups')
        },
        {
          name: 'opportunities',
          text: t('Opportunities')
        },
        {
          name: 'my-roles',
          text: t('My roles')
        },
      ],
    };
  }

  static getDerivedStateFromProps ({ actorAccountIds, requests, roles }: Props): State {
    return {
      actorAccountIds: (actorAccountIds || []).map((accountId) =>
        accountId.toString()
      ),
      requests: (requests || []).map((request) =>
        request
      ),
      roles: (roles || []).map((role) =>
        role
      ),
    } as State;
  }

  render () {
    const { allAccounts } = this.props;
    const { tabs } = this.state;
    const { basePath } = this.props;
    const hasAccounts = allAccounts && Object.keys(allAccounts).length;
    const filteredTabs = hasAccounts
      ? tabs
      : tabs.filter(({ name }) =>
        !['requests'].includes(name)
      );

    return (
      <main className='actors--App'>
        <header>
          <Tabs
            basePath={basePath}
            items={filteredTabs}
          />
        </header>
        <Switch>
          <Route path={`${basePath}/opportunities`} render={this.renderComponent(MyRequests)} />
          <Route path={`${basePath}/my-roles`} render={this.renderComponent(AvailableRoles)} />
          <Route render={this.renderComponent(ActorsList)} />
        </Switch>
      </main>
    );
  }

  private renderComponent (Component: React.ComponentType<ComponentProps>) {
    return (): React.ReactNode => {
      const { actorAccountIds, requests, roles } = this.state;

      return (
        <Component
          actorAccountIds={actorAccountIds}
          requests={requests}
          roles={roles}
        />
      );
    };
  }

}

export default withMulti(
  App,
  translate,
  withObservable(accountObservable.subject, { propName: 'allAccounts' }),
  withCalls<Props>(
    ['query.actors.actorAccountIds', { propName: 'actorAccountIds' }],
    ['query.actors.roleEntryRequests', { propName: 'requests' }],
    ['query.actors.availableRoles', { propName: 'roles' }],
  )
);
