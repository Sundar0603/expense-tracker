import { ref } from 'vue'
import { thisMonth } from './useDates'

/** The month every month-scoped view shows; shared so moving between views keeps the same month. */
export const selectedMonth = ref(thisMonth())
