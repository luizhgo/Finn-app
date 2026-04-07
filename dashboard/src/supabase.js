import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
    'https://eiyvbcwqikmgfnhltxhq.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpeXZiY3dxaWttZ2ZuaGx0eGhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1MjMzMzYsImV4cCI6MjA5MTA5OTMzNn0.fGtZv7zEbdFpMaokpKulJjyYAr3LednQMHkbEzaNgh0'
);