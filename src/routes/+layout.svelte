<script>
  import '../app.css';
  import { page } from '$app/state';
</script>

<div class="flex h-screen bg-gray-50 font-sans">
  <!-- Sidebar -->
  <div class="w-64 bg-indigo-900 text-white flex flex-col">
    <div class="p-6">
      <h1 class="text-2xl font-bold tracking-tight">Tríade</h1>
      <p class="text-indigo-200 text-sm mt-1">Matchmaker</p>
    </div>

    <nav class="flex-1 px-4 space-y-2 mt-4">
      <a
        href="/"
        class="flex items-center px-4 py-3 rounded-lg transition-colors { page.url.pathname === '/' ? 'bg-indigo-800 text-white' : 'text-indigo-100 hover:bg-indigo-800 hover:text-white' }"
      >
        <svg class="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>
        Matches Receptivos
      </a>

      <a
        href="/outbound"
        class="flex items-center px-4 py-3 rounded-lg transition-colors { page.url.pathname === '/outbound' ? 'bg-indigo-800 text-white' : 'text-indigo-100 hover:bg-indigo-800 hover:text-white' }"
      >
        <svg class="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        Radar de Prospecção
      </a>
    </nav>

    <div class="p-4 border-t border-indigo-800">
      <div class="flex items-center">
        <div class="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-sm font-bold">
          A
        </div>
        <div class="ml-3">
          <p class="text-sm font-medium">Angela</p>
          <p class="text-xs text-indigo-300">Consultora</p>
        </div>
      </div>
    </div>
  </div>

  <!-- Main Content -->
  <main class="flex-1 flex flex-col overflow-hidden">
    <slot />
  </main>
</div>
