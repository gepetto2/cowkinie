export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      cinemas: {
        Row: {
          city: string
          created_at: string | null
          franchise: string | null
          id: string
          name: string
        }
        Insert: {
          city: string
          created_at?: string | null
          franchise?: string | null
          id?: string
          name: string
        }
        Update: {
          city?: string
          created_at?: string | null
          franchise?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      movies: {
        Row: {
          cast_cc: string | null
          cast_multikino: string | null
          created_at: string | null
          description_cc: string | null
          description_lumiere: string | null
          description_multikino: string | null
          description_muza: string | null
          description_tmdb: string | null
          director: string | null
          director_cc: string | null
          director_filmweb: string | null
          director_helios: string | null
          director_multikino: string | null
          director_muza: string | null
          director_tmdb: string | null
          genre: string | null
          genre_cc: string | null
          genre_lumiere: string | null
          id: string
          length: number | null
          length_cc: number | null
          length_filmweb: number | null
          length_helios: number | null
          length_lumiere: number | null
          length_multikino: number | null
          length_muza: number | null
          length_tmdb: number | null
          movie_type: string | null
          movie_type_cc: string | null
          movie_type_helios: string | null
          movie_type_multikino: string | null
          movie_type_muza: string | null
          original_title: string | null
          original_title_helios: string | null
          original_title_muza: string | null
          original_title_tmdb: string | null
          poster: string | null
          poster_cc: string | null
          poster_helios: string | null
          poster_multikino: string | null
          poster_muza: string | null
          poster_tmdb: string | null
          release_date: string | null
          release_date_cc: string | null
          release_date_filmweb: string | null
          release_date_helios: string | null
          release_date_multikino: string | null
          release_date_muza: string | null
          release_date_tmdb: string | null
          release_year: number | null
          release_year_cc: number | null
          release_year_filmweb: number | null
          release_year_helios: number | null
          release_year_multikino: number | null
          release_year_muza: number | null
          release_year_tmdb: number | null
          title: string
          title_filmweb: string | null
          title_tmdb: string | null
          tmdb_id: number | null
        }
        Insert: {
          cast_cc?: string | null
          cast_multikino?: string | null
          created_at?: string | null
          description_cc?: string | null
          description_lumiere?: string | null
          description_multikino?: string | null
          description_muza?: string | null
          description_tmdb?: string | null
          director?: string | null
          director_cc?: string | null
          director_filmweb?: string | null
          director_helios?: string | null
          director_multikino?: string | null
          director_muza?: string | null
          director_tmdb?: string | null
          genre?: string | null
          genre_cc?: string | null
          genre_lumiere?: string | null
          id?: string
          length?: number | null
          length_cc?: number | null
          length_filmweb?: number | null
          length_helios?: number | null
          length_lumiere?: number | null
          length_multikino?: number | null
          length_muza?: number | null
          length_tmdb?: number | null
          movie_type?: string | null
          movie_type_cc?: string | null
          movie_type_helios?: string | null
          movie_type_multikino?: string | null
          movie_type_muza?: string | null
          original_title?: string | null
          original_title_helios?: string | null
          original_title_muza?: string | null
          original_title_tmdb?: string | null
          poster?: string | null
          poster_cc?: string | null
          poster_helios?: string | null
          poster_multikino?: string | null
          poster_muza?: string | null
          poster_tmdb?: string | null
          release_date?: string | null
          release_date_cc?: string | null
          release_date_filmweb?: string | null
          release_date_helios?: string | null
          release_date_multikino?: string | null
          release_date_muza?: string | null
          release_date_tmdb?: string | null
          release_year?: number | null
          release_year_cc?: number | null
          release_year_filmweb?: number | null
          release_year_helios?: number | null
          release_year_multikino?: number | null
          release_year_muza?: number | null
          release_year_tmdb?: number | null
          title: string
          title_filmweb?: string | null
          title_tmdb?: string | null
          tmdb_id?: number | null
        }
        Update: {
          cast_cc?: string | null
          cast_multikino?: string | null
          created_at?: string | null
          description_cc?: string | null
          description_lumiere?: string | null
          description_multikino?: string | null
          description_muza?: string | null
          description_tmdb?: string | null
          director?: string | null
          director_cc?: string | null
          director_filmweb?: string | null
          director_helios?: string | null
          director_multikino?: string | null
          director_muza?: string | null
          director_tmdb?: string | null
          genre?: string | null
          genre_cc?: string | null
          genre_lumiere?: string | null
          id?: string
          length?: number | null
          length_cc?: number | null
          length_filmweb?: number | null
          length_helios?: number | null
          length_lumiere?: number | null
          length_multikino?: number | null
          length_muza?: number | null
          length_tmdb?: number | null
          movie_type?: string | null
          movie_type_cc?: string | null
          movie_type_helios?: string | null
          movie_type_multikino?: string | null
          movie_type_muza?: string | null
          original_title?: string | null
          original_title_helios?: string | null
          original_title_muza?: string | null
          original_title_tmdb?: string | null
          poster?: string | null
          poster_cc?: string | null
          poster_helios?: string | null
          poster_multikino?: string | null
          poster_muza?: string | null
          poster_tmdb?: string | null
          release_date?: string | null
          release_date_cc?: string | null
          release_date_filmweb?: string | null
          release_date_helios?: string | null
          release_date_multikino?: string | null
          release_date_muza?: string | null
          release_date_tmdb?: string | null
          release_year?: number | null
          release_year_cc?: number | null
          release_year_filmweb?: number | null
          release_year_helios?: number | null
          release_year_multikino?: number | null
          release_year_muza?: number | null
          release_year_tmdb?: number | null
          title?: string
          title_filmweb?: string | null
          title_tmdb?: string | null
          tmdb_id?: number | null
        }
        Relationships: []
      }
      screenings: {
        Row: {
          availability_ratio: number | null
          booking_link: string | null
          cinema_id: string
          created_at: string | null
          duration: number | null
          end_time: string | null
          format: string | null
          id: string
          lang: string | null
          movie_id: string
          room_name: string | null
          start_time: string
        }
        Insert: {
          availability_ratio?: number | null
          booking_link?: string | null
          cinema_id: string
          created_at?: string | null
          duration?: number | null
          end_time?: string | null
          format?: string | null
          id?: string
          lang?: string | null
          movie_id: string
          room_name?: string | null
          start_time: string
        }
        Update: {
          availability_ratio?: number | null
          booking_link?: string | null
          cinema_id?: string
          created_at?: string | null
          duration?: number | null
          end_time?: string | null
          format?: string | null
          id?: string
          lang?: string | null
          movie_id?: string
          room_name?: string | null
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "screenings_cinema_id_fkey"
            columns: ["cinema_id"]
            isOneToOne: false
            referencedRelation: "cinemas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screenings_movie_id_fkey"
            columns: ["movie_id"]
            isOneToOne: false
            referencedRelation: "movies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      movie_cinemas_view: {
        Row: {
          cities: string[] | null
          franchises: string[] | null
          movie_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "screenings_movie_id_fkey"
            columns: ["movie_id"]
            isOneToOne: false
            referencedRelation: "movies"
            referencedColumns: ["id"]
          },
        ]
      }
      movie_dates_view: {
        Row: {
          city: string | null
          movie_id: string | null
          screening_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "screenings_movie_id_fkey"
            columns: ["movie_id"]
            isOneToOne: false
            referencedRelation: "movies"
            referencedColumns: ["id"]
          },
        ]
      }
      movie_screening_counts: {
        Row: {
          movie_id: string | null
          screening_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "screenings_movie_id_fkey"
            columns: ["movie_id"]
            isOneToOne: false
            referencedRelation: "movies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
