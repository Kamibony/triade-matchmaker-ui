<script lang="ts">
  // App.svelte: Main entry component with responsive layout
</script>

<div class="flex h-screen bg-gray-50 text-gray-900">
  <!-- Sidebar -->
  <aside class="w-64 bg-white border-r border-gray-200 hidden md:block">
    <div class="p-6">
      <h1 class="text-xl font-bold text-gray-800">NGOs</h1>
      <p class="text-sm text-gray-500 mt-2">List of non-profits</p>
    </div>
    <nav class="mt-6">
      <ul class="space-y-2 px-4">
        <!-- NGO List will be populated here -->
        <li class="p-2 bg-blue-50 text-blue-700 rounded-md cursor-pointer font-medium">NGO Name 1</li>
        <li class="p-2 hover:bg-gray-100 rounded-md cursor-pointer">NGO Name 2</li>
        <li class="p-2 hover:bg-gray-100 rounded-md cursor-pointer">NGO Name 3</li>
      </ul>
    </nav>
  </aside>

  <!-- Main Content Area -->
  <main class="flex-1 overflow-y-auto p-8">
    <header class="mb-8">
      <h2 class="text-2xl font-bold text-gray-800">Matched Grants</h2>
      <p class="text-gray-600 mt-2">Available grants based on the selected NGO.</p>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <!-- Grant Cards will be populated here -->

      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
        <div class="flex justify-between items-start mb-4">
          <h3 class="text-lg font-semibold text-gray-900">Grant Title Example</h3>
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Open</span>
        </div>
        <p class="text-sm text-gray-600 mb-4 line-clamp-3">This is a short description of the grant opportunity. It provides key details about funding, eligibility, and deadlines.</p>
        <div class="mt-auto">
          <div class="text-sm font-medium text-gray-900">Amount: R$ 50.000</div>
          <div class="text-xs text-gray-500 mt-1">Deadline: Oct 31, 2024</div>
        </div>
      </div>

      <div class="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
        <div class="flex justify-between items-start mb-4">
          <h3 class="text-lg font-semibold text-gray-900">Another Grant Opportunity</h3>
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Closing Soon</span>
        </div>
        <p class="text-sm text-gray-600 mb-4 line-clamp-3">Description for another grant available for NGOs focusing on education and technology initiatives.</p>
        <div class="mt-auto">
          <div class="text-sm font-medium text-gray-900">Amount: R$ 100.000</div>
          <div class="text-xs text-gray-500 mt-1">Deadline: Oct 28, 2024</div>
        </div>
      </div>

    </div>
  </main>
</div>
