import { Router } from 'express';
import { authenticate, requireAccount, requireTenant } from './middleware/auth.js';
import { accountRouter } from './modules/accounts/accounts.routes.js';
import { agreementsRouter } from './modules/agreements/agreements.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { expensesRouter } from './modules/expenses/expenses.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { portalRouter } from './modules/portal/portal.routes.js';
import { propertiesRouter } from './modules/properties/properties.routes.js';
import { rentsRouter } from './modules/rents/rents.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { tenantsRouter } from './modules/tenants/tenants.routes.js';
import { unitsRouter } from './modules/units/units.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

export function apiRouter(): Router {
  const router = Router();

  // Public
  router.use('/auth', authRouter);

  // Any signed-in user
  router.use('/users', authenticate, usersRouter);
  router.use('/notifications', authenticate, notificationsRouter);

  // Landlord side (owner or partner of an account)
  const owner = [authenticate, requireAccount];
  router.use('/account', ...owner, accountRouter);
  router.use('/dashboard', ...owner, dashboardRouter);
  router.use('/properties', ...owner, propertiesRouter);
  router.use('/units', ...owner, unitsRouter);
  router.use('/tenants', ...owner, tenantsRouter);
  router.use('/agreements', ...owner, agreementsRouter);
  router.use('/rents', ...owner, rentsRouter);
  router.use('/payments', ...owner, paymentsRouter);
  router.use('/expenses', ...owner, expensesRouter);
  router.use('/reports', ...owner, reportsRouter);

  // Tenant portal
  router.use('/portal', authenticate, requireTenant, portalRouter);

  return router;
}
