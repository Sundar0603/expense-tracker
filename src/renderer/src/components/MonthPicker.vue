<script setup lang="ts">
import { monthLabel, shiftMonth, thisMonth } from '../composables/useDates'

/** A YYYY-MM month, or null for all time (only when allowAll). */
const props = defineProps<{ modelValue: string | null; allowAll?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [string | null] }>()

function shift(delta: number): void {
  emit('update:modelValue', props.modelValue ? shiftMonth(props.modelValue, delta) : thisMonth())
}
</script>

<template>
  <div class="row">
    <button class="sm" title="Previous month" @click="shift(-1)">‹</button>
    <strong style="min-width: 130px; text-align: center">{{ modelValue ? monthLabel(modelValue) : 'All time' }}</strong>
    <button class="sm" title="Next month" :disabled="!modelValue || modelValue >= thisMonth()" @click="shift(1)">›</button>
    <button v-if="allowAll" class="sm" :class="{ primary: modelValue === null }" @click="emit('update:modelValue', modelValue === null ? thisMonth() : null)">
      All time
    </button>
  </div>
</template>
