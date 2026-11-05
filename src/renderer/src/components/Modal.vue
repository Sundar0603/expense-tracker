<script setup lang="ts">
defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal" role="dialog" :aria-label="title">
      <h3>{{ title }}</h3>
      <slot />
    </div>
  </div>
</template>
