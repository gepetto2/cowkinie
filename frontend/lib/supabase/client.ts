import { createClient } from '@supabase/supabase-js';
import { Database } from '@/types/database.types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Inicjalizacja klienta z podpiętymi typami bazy danych
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
