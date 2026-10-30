import { createRouter, createWebHashHistory } from 'vue-router'
import Home from '@/views/Home.vue'
import ExamplePage from '@/views/ExamplePage.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    {
      path: '/e/:techId/:exampleId',
      name: 'example',
      component: ExamplePage,
      props: true,
    },
  ],
})
