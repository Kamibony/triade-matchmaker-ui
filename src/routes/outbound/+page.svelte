<script lang="ts">
  import OutboundRadar from '$lib/components/OutboundRadar.svelte';
  export let data;
</script>

<OutboundRadar leads={data.leads} bancoEditais={data.bancoEditais || []} />
