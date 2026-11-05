import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
    { path: '/transactions', name: 'transactions', component: () => import('./views/TransactionsView.vue') },
    { path: '/friends', name: 'friends', component: () => import('./views/FriendsView.vue') },
    { path: '/categories', name: 'categories', component: () => import('./views/CategoriesView.vue') },
    { path: '/rules', name: 'rules', component: () => import('./views/RulesView.vue') },
    { path: '/budgets', name: 'budgets', component: () => import('./views/BudgetsView.vue') },
    { path: '/insights', name: 'insights', component: () => import('./views/InsightsView.vue') },
    { path: '/ai', name: 'ai', component: () => import('./views/AiView.vue') },
    { path: '/import', name: 'import', component: () => import('./views/ImportView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') }
  ]
})
